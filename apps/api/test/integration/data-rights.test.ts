import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, latestCode, makeApp, resetData, signUp, type Ctx } from '../helpers';
import { clock, onShift, seedRates, verifiedBusiness, verifiedWorker, workedShift, type Biz } from '../fixtures';
import { applyRetention } from '../../src/privacy';

let ctx: Ctx;
let biz: Biz;
beforeAll(async () => {
  ctx = await makeApp();
  await resetData(ctx.db);
  await seedRates(ctx);
  biz = await verifiedBusiness(ctx);
});
afterAll(async () => closeApp(ctx));

const del = (auth: { authorization: string }) => ctx.app.inject({ method: 'POST', url: '/me/delete', headers: auth, payload: { confirm: 'DELETE' } });

describe('export (DPDP right to access)', () => {
  it('returns the worker’s own data, decrypted, and nothing about Aadhaar', async () => {
    const w = await verifiedWorker(ctx, { name: 'Asha Rao' });
    const r = await ctx.app.inject({ method: 'GET', url: '/me/export', headers: w.auth });
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const d = r.json();
    expect(d.account.phone).toBe(w.phone);
    expect(d.workerProfile.legalName).toBe('Asha Rao');
    expect(d.workerProfile.faceTemplateStored).toBe(true);
    expect(d.payoutMethods).toHaveLength(1);
    expect(JSON.stringify(d)).not.toMatch(/aadhaar_|kyc_ref|face_embedding|phone_hash/i);
    const audit = await ctx.db.query(`SELECT 1 FROM audit_log WHERE action = 'user.data_exported' AND actor_id = $1`, [w.userId]);
    expect(audit.rowCount).toBe(1);
  });

  it('needs a login', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/me/export' })).statusCode).toBe(401);
  });
});

describe('consent withdrawal', () => {
  it('turning off face checks blocks check-in until allowed again', async () => {
    const s = await onShift(ctx, biz);
    const off = await ctx.app.inject({ method: 'POST', url: '/me/consents/face_verification/withdraw', headers: s.worker.auth });
    expect(off.statusCode).toBe(200);
    const blocked = await clock(ctx, s.worker, s.bookingId, s.shift.id, 'check-in');
    expect(blocked.statusCode).toBe(403);
    await ctx.app.inject({ method: 'POST', url: '/me/consents/face_verification/grant', headers: s.worker.auth });
    expect((await clock(ctx, s.worker, s.bookingId, s.shift.id, 'check-in')).statusCode).toBe(200);
    const c = (await ctx.app.inject({ method: 'GET', url: '/me/consents', headers: s.worker.auth })).json();
    expect(c.face_verification).toBe(true);
  });

  it('turning off notifications stops reminders and WhatsApp; the account consent can’t be withdrawn this way', async () => {
    const w = await signUp(ctx, 'worker');
    await ctx.db.query('UPDATE users SET whatsapp_opt_in_at = now() WHERE id = $1', [w.userId]);
    expect((await ctx.app.inject({ method: 'POST', url: '/me/consents/notifications/withdraw', headers: w.auth })).statusCode).toBe(200);
    const u = (await ctx.db.query('SELECT whatsapp_opt_in_at, reminders_opt_out FROM users WHERE id = $1', [w.userId])).rows[0];
    expect(u).toEqual({ whatsapp_opt_in_at: null, reminders_opt_out: true });
    expect((await ctx.app.inject({ method: 'POST', url: '/me/consents/account/withdraw', headers: w.auth })).statusCode).toBe(400);
  });
});

describe('account deletion (DPDP right to erasure)', () => {
  it('needs a typed confirmation', async () => {
    const w = await signUp(ctx, 'worker');
    expect((await ctx.app.inject({ method: 'POST', url: '/me/delete', headers: w.auth, payload: {} })).statusCode).toBe(400);
  });

  it('is refused while a shift is coming up, so nobody walks out on a booking or loses pay', async () => {
    const s = await onShift(ctx, biz);
    const r = await del(s.worker.auth);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('upcoming_shifts');
  });

  it('is refused while pay is still on its way', async () => {
    const s = await workedShift(ctx, biz);
    const r = await del(s.worker.auth);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('money_pending');
  });

  it('removes personal data, keeps legally required records, and signs the user out everywhere', async () => {
    const w = await verifiedWorker(ctx, { name: 'Meena K' });
    const before = (await ctx.db.query('SELECT count(*)::int AS n FROM audit_log')).rows[0].n;
    const r = await del(w.auth);
    expect(r.statusCode).toBe(200);
    expect(r.json().kept).toMatch(/Pay, tax/);

    const u = (await ctx.db.query('SELECT status, phone_hash, phone_last4, deleted_reason FROM users WHERE id = $1', [w.userId])).rows[0];
    expect(u).toMatchObject({ status: 'deleted', phone_last4: '0000', deleted_reason: 'user_request' });
    expect(u.phone_hash).toMatch(/^deleted:/);
    const p = (await ctx.db.query('SELECT legal_name_enc, face_embedding, home_point, kyc_ref_hash, trusted_contact_phone_enc FROM worker_profiles WHERE user_id = $1', [w.userId])).rows[0];
    expect(p).toEqual({ legal_name_enc: null, face_embedding: null, home_point: null, kyc_ref_hash: null, trusted_contact_phone_enc: null });
    const pm = (await ctx.db.query('SELECT vpa_enc, status FROM payout_methods WHERE worker_id = $1', [w.userId])).rows[0];
    expect(pm).toEqual({ vpa_enc: null, status: 'replaced' });

    expect((await ctx.app.inject({ method: 'GET', url: '/me', headers: w.auth })).statusCode).toBe(401);
    expect((await ctx.db.query('SELECT count(*)::int AS n FROM audit_log')).rows[0].n).toBe(before + 1);
    expect((await del(w.auth)).statusCode).toBe(401);
  });

  it('a voluntary deletion frees the number for a fresh account', async () => {
    const w = await signUp(ctx, 'worker');
    await del(w.auth);
    const again = await signUp(ctx, 'worker', w.phone);
    expect(again.userId).not.toBe(w.userId);
  });

  it('deleting while limited can’t be used to come back clean (WRK-07)', async () => {
    const w = await verifiedWorker(ctx);
    await ctx.db.query(`UPDATE worker_profiles SET limited_until = now() + interval '7 days' WHERE user_id = $1`, [w.userId]);
    expect((await del(w.auth)).statusCode).toBe(200);
    const kept = (await ctx.db.query('SELECT kyc_ref_hash FROM worker_profiles WHERE user_id = $1', [w.userId])).rows[0];
    expect(kept.kyc_ref_hash).not.toBeNull();

    // Same number: refused at sign-up.
    await ctx.app.inject({ method: 'POST', url: '/auth/otp/request', payload: { phone: w.phone } });
    const code = await latestCode(ctx, w.phone);
    const v = await ctx.app.inject({ method: 'POST', url: '/auth/otp/verify', payload: { phone: w.phone, code, deviceId: 'device-wrk07', platform: 'android', signup: { kind: 'worker', lang: 'hi', consents: ['account'] } } });
    expect(v.statusCode, v.body).toBe(403);
    // New number, same identity: refused at KYC.
    await expect(verifiedWorker(ctx, { personId: w.personId })).rejects.toThrow(/kyc failed/);
  });
});

describe('retention job', () => {
  it('removes old location, chat and notification bodies; keeps the attendance record itself', async () => {
    const s = await workedShift(ctx, biz);
    await ctx.db.query(`ALTER TABLE attendance_events DISABLE TRIGGER attendance_events_append_only`);
    await ctx.db.query(`UPDATE attendance_events SET created_at = now() - interval '400 days' WHERE booking_id = $1`, [s.bookingId]);
    await ctx.db.query(`ALTER TABLE attendance_events ENABLE TRIGGER attendance_events_append_only`);
    await ctx.db.query(`INSERT INTO otp_requests (id, phone_hash, code_hash, ip, created_at, expires_at) VALUES (gen_random_uuid(), 'old', 'x', '1.1.1.1', now() - interval '40 days', now() - interval '40 days')`);

    const out = await applyRetention(ctx.db);
    expect(out.attendanceLocations).toBeGreaterThanOrEqual(2);
    expect(out.otps).toBeGreaterThanOrEqual(1);
    const ev = (await ctx.db.query('SELECT lat, lng, type, effective_at FROM attendance_events WHERE booking_id = $1', [s.bookingId])).rows;
    expect(ev.every((e) => e.lat === null && e.lng === null && e.effective_at)).toBe(true);
    expect((await applyRetention(ctx.db)).attendanceLocations).toBe(0); // safe to re-run
  });

  it('the append-only guard still refuses any other change to attendance', async () => {
    await expect(ctx.db.query(`UPDATE attendance_events SET lat = NULL, lng = NULL, accuracy_m = NULL, effective_at = now()`)).rejects.toThrow(/append-only/);
    await expect(ctx.db.query(`DELETE FROM attendance_events`)).rejects.toThrow(/append-only/);
  });
});
