// WRK-01 multiple accounts · WRK-02 someone else's face · WRK-06 underage · WRK-07 re-registering ·
// MON-04 payout change after takeover · OFF-02 paying into someone else's account.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, makeApp, resetData, signUp, type Ctx, type LoggedIn } from '../helpers';
import { seedRates, verifiedWorker } from '../fixtures';

let ctx: Ctx;
beforeAll(async () => { ctx = await makeApp(); await resetData(ctx.db); await seedRates(ctx); });
afterAll(async () => closeApp(ctx));

async function kyc(w: LoggedIn, persona: { personId: string; name?: string; dob?: string; faceId?: string }) {
  const s = (await ctx.app.inject({ method: 'POST', url: '/worker/kyc/start', headers: w.auth })).json();
  await ctx.app.inject({ method: 'POST', url: `/mock/digilocker/${s.sessionId}/approve`, payload: { name: 'Meena Devi', dob: '1995-01-01', ...persona } });
  return ctx.app.inject({ method: 'POST', url: '/worker/kyc/complete', headers: w.auth, payload: { sessionId: s.sessionId } });
}
const me = async (w: LoggedIn) => (await ctx.app.inject({ method: 'GET', url: '/worker/me', headers: w.auth })).json();
const flags = async (userId: string) => (await ctx.db.query(`SELECT rule_code FROM fraud_flags WHERE subject_id = $1 AND status = 'open'`, [userId])).rows.map((r) => r.rule_code);

describe('WRK-01 / WRK-07 one person, one account', () => {
  it('the same identity document cannot verify a second account (new phone number)', async () => {
    const first = await verifiedWorker(ctx);
    const second = await signUp(ctx, 'worker');
    const r = await kyc(second, { personId: first.personId });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('identity_already_registered');
    expect(await flags(second.userId)).toContain('duplicate_identity');
    expect((await me(second)).verificationStatus).not.toBe('verified');
  });

  it('the same face behind different ID documents is flagged and held for review', async () => {
    const face = `face-${randomUUID()}`;
    await verifiedWorker(ctx, { faceId: face });
    const second = await signUp(ctx, 'worker');
    expect((await kyc(second, { personId: `p-${randomUUID()}`, faceId: face })).statusCode).toBe(200);
    const sf = await ctx.app.inject({ method: 'POST', url: '/worker/selfie', headers: second.auth, payload: { mockPersonId: face } });
    expect(sf.statusCode).toBe(200);
    expect(await flags(second.userId)).toContain('duplicate_face');
    expect(sf.json().verificationStatus).toBe('review');
  });

  it('one bank account / UPI ID cannot be shared between workers', async () => {
    const vpa = `shared${randomUUID().slice(0, 6)}@okicici`;
    const a = await verifiedWorker(ctx, { vpa });
    const b = await signUp(ctx, 'worker');
    await kyc(b, { personId: `p-${randomUUID()}` });
    await ctx.app.inject({ method: 'POST', url: '/worker/selfie', headers: b.auth, payload: { mockPersonId: 'x' } }).catch(() => {});
    const r = await ctx.app.inject({ method: 'POST', url: '/worker/payout-method', headers: b.auth, payload: { type: 'upi', vpa } });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('account_in_use');
    expect(await flags(a.userId)).toContain('duplicate_account');
  });

  it('three worker accounts on one phone get flagged', async () => {
    const device = `shared-device-${randomUUID()}`;
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const phone = `+9196${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
      await ctx.app.inject({ method: 'POST', url: '/auth/otp/request', payload: { phone }, remoteAddress: `10.9.9.${i}` });
      const code = (await ctx.app.inject({ method: 'POST', url: '/dev/outbox', payload: { phone } })).json()[0].body.match(/\d{6}/)[0];
      const v = await ctx.app.inject({ method: 'POST', url: '/auth/otp/verify', remoteAddress: `10.9.9.${i}`, payload: { phone, code, deviceId: device, signup: { kind: 'worker', lang: 'hi', consents: ['account'] } } });
      ids.push(v.json().user.id);
    }
    for (const id of ids) expect(await flags(id)).toContain('device_shared');
  });
});

describe('WRK-02 the selfie must be the account holder', () => {
  it('a different person in the selfie is rejected and flagged', async () => {
    const w = await signUp(ctx, 'worker');
    await kyc(w, { personId: `p-${randomUUID()}` });
    const r = await ctx.app.inject({ method: 'POST', url: '/worker/selfie', headers: w.auth, payload: { mockPersonId: 'somebody-else' } });
    expect(r.json().error.code).toBe('face_mismatch');
    expect(await flags(w.userId)).toContain('selfie_kyc_mismatch');
  });

  it('a photo of a photo fails liveness', async () => {
    const pid = `p-${randomUUID()}`;
    const w = await signUp(ctx, 'worker');
    await kyc(w, { personId: pid });
    const r = await ctx.app.inject({ method: 'POST', url: '/worker/selfie', headers: w.auth, payload: { mockPersonId: pid, mockSpoof: true } });
    expect(r.json().error.code).toBe('liveness_failed');
  });
});

describe('WRK-06 underage', () => {
  it('age comes from the ID document; under 18 is blocked', async () => {
    const w = await signUp(ctx, 'worker');
    const year = new Date().getFullYear() - 17;
    const r = await kyc(w, { personId: `p-${randomUUID()}`, dob: `${year}-01-01` });
    expect(r.statusCode).toBe(403);
    expect(r.json().error.code).toBe('underage');
    expect((await me(w)).verificationStatus).toBe('rejected');
    // And they can't simply retry.
    expect((await ctx.app.inject({ method: 'POST', url: '/worker/kyc/start', headers: w.auth })).statusCode).toBe(403);
  });

  it('turning 18 today is allowed; 18 tomorrow is not', async () => {
    const ist = new Date(Date.now() + 330 * 60_000);
    const y = ist.getUTCFullYear() - 18, m = String(ist.getUTCMonth() + 1).padStart(2, '0'), d = String(ist.getUTCDate()).padStart(2, '0');
    const today = await kyc(await signUp(ctx, 'worker'), { personId: `p-${randomUUID()}`, dob: `${y}-${m}-${d}` });
    expect(today.statusCode).toBe(200);
    const tomorrow = new Date(Date.UTC(y, ist.getUTCMonth(), ist.getUTCDate() + 1)).toISOString().slice(0, 10);
    const r = await kyc(await signUp(ctx, 'worker'), { personId: `p-${randomUUID()}`, dob: tomorrow });
    expect(r.statusCode).toBe(403);
  });

  it('we store the birth year only, never the full date of birth or any ID number', async () => {
    const w = await verifiedWorker(ctx, { dob: '1990-07-23' });
    const row = (await ctx.db.query('SELECT * FROM worker_profiles WHERE user_id = $1', [w.userId])).rows[0];
    expect(row.dob_year).toBe(1990);
    const dump = JSON.stringify(row);
    expect(dump).not.toContain('1990-07-23');
    expect(dump).not.toContain(w.personId);
    expect(dump).not.toContain('Kumar'); // surname only exists encrypted
  });
});

describe('MON-04 / OFF-02 payout account safety', () => {
  it("an account in someone else's name is rejected; a partial match goes to review", async () => {
    const w = await signUp(ctx, 'worker');
    const pid = `p-${randomUUID()}`;
    await kyc(w, { personId: pid, name: 'Lakshmi Narayan' });
    const bad = await ctx.app.inject({ method: 'POST', url: '/worker/payout-method', headers: w.auth, payload: { type: 'upi', vpa: `mismatch${randomUUID().slice(0, 4)}@ybl` } });
    expect(bad.json().error.code).toBe('name_mismatch');
    const partial = await ctx.app.inject({ method: 'POST', url: '/worker/payout-method', headers: w.auth, payload: { type: 'upi', vpa: `partial${randomUUID().slice(0, 4)}@ybl` } });
    expect(partial.json().status).toBe('review');
  });

  it('changing the payout account needs a fresh selfie and starts a 24h cooldown', async () => {
    const w = await verifiedWorker(ctx);
    await ctx.db.query(`UPDATE worker_profiles SET last_liveness_at = now() - interval '1 hour' WHERE user_id = $1`, [w.userId]);
    const r1 = await ctx.app.inject({ method: 'POST', url: '/worker/payout-method', headers: w.auth, payload: { type: 'upi', vpa: `new${randomUUID().slice(0, 6)}@okaxis` } });
    expect(r1.json().error.code).toBe('liveness_required');
    await ctx.app.inject({ method: 'POST', url: '/worker/selfie', headers: w.auth, payload: { mockPersonId: w.personId } });
    const r2 = await ctx.app.inject({ method: 'POST', url: '/worker/payout-method', headers: w.auth, payload: { type: 'upi', vpa: `new${randomUUID().slice(0, 6)}@okaxis` } });
    expect(r2.statusCode).toBe(201);
    expect(new Date(r2.json().cooldownUntil).getTime()).toBeGreaterThan(Date.now() + 23 * 3600_000);
    const methods = await ctx.db.query('SELECT status FROM payout_methods WHERE worker_id = $1 ORDER BY created_at', [w.userId]);
    expect(methods.rows.map((m) => m.status)).toEqual(['replaced', 'verified']);
  });

  it('payout details are stored encrypted and shown masked', async () => {
    const vpa = `secret${randomUUID().slice(0, 6)}@okhdfc`;
    const w = await verifiedWorker(ctx, { vpa });
    const row = (await ctx.db.query('SELECT * FROM payout_methods WHERE worker_id = $1', [w.userId])).rows[0];
    expect(JSON.stringify(row)).not.toContain(vpa);
    expect(row.display).toMatch(/^se\*\*\*\*@okhdfc$/);
  });
});
