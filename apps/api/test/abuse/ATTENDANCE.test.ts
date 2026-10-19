// WRK-02 proxy worker · WRK-03 buddy punching · WRK-04 GPS spoofing · WRK-05 screenshotted QR ·
// WRK-12 leaving mid-shift · SYS-08 offline clock tampering · PAY-06 unpaid late stay · PAY-12 ghost workers.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, makeApp, resetData, type Ctx } from '../helpers';
import { WHITEFIELD, clock, clockBody, currentCode, onShift, seedRates, startShiftAgo, verifiedBusiness, workedShift, type Biz } from '../fixtures';
import { siteSecret } from '../../src/attendance';
import { gateCode, qrStep, shiftKey } from '../../src/domain/qr';

let ctx: Ctx;
let b: Biz;
beforeAll(async () => { ctx = await makeApp(); await resetData(ctx.db); await seedRates(ctx); b = await verifiedBusiness(ctx); });
afterAll(async () => closeApp(ctx));

const flagsOf = async (subject: string) => (await ctx.db.query(`SELECT rule_code FROM fraud_flags WHERE subject_id = $1 AND status = 'open'`, [subject])).rows.map((r) => r.rule_code);
const rejected = async (bookingId: string) => (await ctx.db.query(`SELECT flags FROM attendance_events WHERE booking_id = $1 AND status = 'rejected'`, [bookingId])).rows.map((r) => r.flags[0]);

describe('WRK-02 / WRK-03 someone else at the gate', () => {
  it("a different person's face is refused, recorded and flagged", async () => {
    const s = await onShift(ctx, b);
    const r = await clock(ctx, s.worker, s.bookingId, s.shift.id, 'check-in', { selfie: { mockPersonId: 'the-friend' } });
    expect(r.json().error.code).toBe('face_mismatch');
    expect(await rejected(s.bookingId)).toContain('face_mismatch');
    expect(await flagsOf(s.worker.userId)).toContain('attendance_face_mismatch');
    const booking = (await ctx.db.query('SELECT status FROM bookings WHERE id = $1', [s.bookingId])).rows[0];
    expect(booking.status).toBe('confirmed');
  });

  it('a photo held up to the camera fails liveness', async () => {
    const s = await onShift(ctx, b);
    const r = await clock(ctx, s.worker, s.bookingId, s.shift.id, 'check-in', { selfie: { mockPersonId: s.worker.personId, mockSpoof: true } });
    expect(r.json().error.code).toBe('liveness_failed');
  });
});

describe('WRK-05 gate codes', () => {
  it('a code from 2 minutes ago (screenshot / WhatsApp forward) is refused', async () => {
    const s = await onShift(ctx, b);
    const old = await currentCode(ctx, s.shift.id, Date.now() - 120_000);
    const r = await ctx.app.inject({ method: 'POST', url: `/worker/bookings/${s.bookingId}/check-in`, headers: s.worker.auth, payload: clockBody(s.worker, old) });
    expect(r.json().error.code).toBe('bad_code');
  });

  it("another shift's code (even at the same site, same moment) is refused", async () => {
    const a = await onShift(ctx, b);
    const other = await onShift(ctx, b, { startsAt: (await import('../fixtures')).istSlot(3, 9), endsAt: (await import('../fixtures')).istSlot(3, 17) });
    const r = await ctx.app.inject({ method: 'POST', url: `/worker/bookings/${a.bookingId}/check-in`, headers: a.worker.auth, payload: clockBody(a.worker, await currentCode(ctx, other.shift.id)) });
    expect(r.statusCode).toBe(400);
  });

  it('a full QR payload for another shift is named as such', async () => {
    const a = await onShift(ctx, b);
    const site = (await ctx.db.query('SELECT site_id FROM shifts WHERE id = $1', [a.shift.id])).rows[0].site_id;
    const key = shiftKey(await siteSecret(ctx.db, site, ctx.config.dataKey), 'some-other-shift');
    const payload = `sk1.some-other-shift.${qrStep(Date.now())}.${gateCode(key, qrStep(Date.now()))}`;
    const r = await ctx.app.inject({ method: 'POST', url: `/worker/bookings/${a.bookingId}/check-in`, headers: a.worker.auth, payload: clockBody(a.worker, payload) });
    expect(r.json().error.message).toMatch(/different shift/);
  });

  it('a correct code from far away fails the geofence; huge "accuracy" does not widen it', async () => {
    const s = await onShift(ctx, b);
    const far = { lat: WHITEFIELD.lat + 0.05, lng: WHITEFIELD.lng }; // ~5.5 km
    const r = await clock(ctx, s.worker, s.bookingId, s.shift.id, 'check-in', { ...far, accuracyM: 99_000 });
    expect(r.json().error.code).toBe('outside_site');
  });

  it('checking in twice is refused', async () => {
    const s = await onShift(ctx, b);
    expect((await clock(ctx, s.worker, s.bookingId, s.shift.id, 'check-in')).statusCode).toBe(200);
    expect((await clock(ctx, s.worker, s.bookingId, s.shift.id, 'check-in')).statusCode).toBe(409);
  });

  it('check-in is not open hours before the shift', async () => {
    const s = await onShift(ctx, b);
    await startShiftAgo(ctx, s.shift.id, -180); // starts in 3 hours
    expect((await clock(ctx, s.worker, s.bookingId, s.shift.id, 'check-in')).json().error.code).toBe('outside_window');
  });
});

describe('WRK-04 spoofed GPS / tampered phone: flagged, not silently blocked', () => {
  it('mock location and failed integrity are recorded, shown to the supervisor and sent to review', async () => {
    const s = await onShift(ctx, b);
    const r = await clock(ctx, s.worker, s.bookingId, s.shift.id, 'check-in', { mockLocation: true, integrityToken: 'mock:fail', accuracyM: 400 });
    expect(r.statusCode).toBe(200);
    expect(r.json().status).toBe('flagged');
    expect(r.json().flags).toEqual(expect.arrayContaining(['mock_location', 'device_integrity_fail', 'low_gps_accuracy']));
    expect(await flagsOf(s.worker.userId)).toContain('attendance_spoof_suspected');
    const roster = (await ctx.app.inject({ method: 'GET', url: `/businesses/${b.businessId}/shifts/${s.shift.id}/attendance`, headers: b.owner.auth })).json();
    expect(roster.find((x: { bookingId: string }) => x.bookingId === s.bookingId).flags).toContain('mock_location');
  });
});

describe('SYS-08 offline check-in with a tampered clock', () => {
  it('the time comes from the QR step, and a big phone-clock difference is flagged', async () => {
    const s = await onShift(ctx, b);
    const scannedAt = Date.now() - 2 * 60_000;
    const code = await currentCode(ctx, s.shift.id, scannedAt);
    // Phone claims it scanned 20 minutes earlier than the code it actually saw.
    const r = await ctx.app.inject({
      method: 'POST', url: `/worker/bookings/${s.bookingId}/check-in`, headers: s.worker.auth,
      payload: clockBody(s.worker, code, { offlineOccurredAt: new Date(scannedAt - 20 * 60_000).toISOString() }),
    });
    // The code doesn't match the claimed time, so it's refused outright.
    expect(r.json().error.code).toBe('bad_code');

    const ok = await ctx.app.inject({
      method: 'POST', url: `/worker/bookings/${s.bookingId}/check-in`, headers: s.worker.auth,
      payload: clockBody(s.worker, code, { offlineOccurredAt: new Date(scannedAt).toISOString() }),
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().flags).toContain('offline_sync');
    const ev = (await ctx.db.query(`SELECT effective_at, occurred_at, mode FROM attendance_events WHERE booking_id = $1 AND status <> 'rejected'`, [s.bookingId])).rows[0];
    expect(ev.mode).toBe('offline_qr');
    expect(Math.abs(ev.effective_at.getTime() - scannedAt)).toBeLessThan(60_000);
  });

  it('offline records older than 24 h are refused', async () => {
    const s = await onShift(ctx, b);
    const r = await ctx.app.inject({
      method: 'POST', url: `/worker/bookings/${s.bookingId}/check-in`, headers: s.worker.auth,
      payload: clockBody(s.worker, '123456', { offlineOccurredAt: new Date(Date.now() - 30 * 3600_000).toISOString() }),
    });
    expect(r.json().error.code).toBe('too_old');
  });
});

describe('PAY-06 staying late without agreed overtime', () => {
  it('is not paid but is flagged on the timesheet', async () => {
    const s = await workedShift(ctx, b);
    await ctx.db.query('ALTER TABLE timesheets DISABLE TRIGGER timesheets_frozen');
    await ctx.db.query('DELETE FROM timesheets WHERE booking_id = $1', [s.bookingId]);
    await ctx.db.query('ALTER TABLE timesheets ENABLE TRIGGER timesheets_frozen');
    // Recompute as if check-out happened 40 minutes after the end.
    await ctx.db.query('ALTER TABLE attendance_events DISABLE TRIGGER attendance_events_append_only');
    await ctx.db.query(`UPDATE attendance_events SET effective_at = (SELECT ends_at FROM shifts WHERE id = $2) + interval '40 minutes' WHERE booking_id = $1 AND type = 'check_out'`, [s.bookingId, s.shift.id]);
    await ctx.db.query('ALTER TABLE attendance_events ENABLE TRIGGER attendance_events_append_only');
    const { createTimesheet } = await import('../../src/attendance');
    const client = await ctx.db.connect();
    try {
      const t = await createTimesheet(client, s.bookingId);
      expect(t.flags).toContain('stayed_late_no_overtime');
      expect(t.overtime_minutes).toBe(0);
      expect(t.payable_minutes).toBe(450);
    } finally { client.release(); }
  });
});

describe('WRK-12 leaving the site mid-shift', () => {
  it('20+ minutes outside the geofence (not on a break) raises a review flag', async () => {
    const s = await onShift(ctx, b);
    await ctx.db.query(`INSERT INTO consents (user_id, purpose, version, lang) VALUES ($1, 'location_at_shift', 'draft-0', 'en')`, [s.worker.userId]);
    await clock(ctx, s.worker, s.bookingId, s.shift.id, 'check-in');
    await ctx.db.query(`INSERT INTO attendance_pings (booking_id, inside, distance_m, at) VALUES ($1, false, 3000, now() - interval '25 minutes')`, [s.bookingId]);
    const far = { lat: WHITEFIELD.lat + 0.03, lng: WHITEFIELD.lng, accuracyM: 20 };
    expect((await ctx.app.inject({ method: 'POST', url: `/worker/bookings/${s.bookingId}/ping`, headers: s.worker.auth, payload: far })).json().inside).toBe(false);
    expect(await flagsOf(s.worker.userId)).toContain('left_site_during_shift');
  });

  it('pings need the location consent', async () => {
    const s = await onShift(ctx, b);
    await clock(ctx, s.worker, s.bookingId, s.shift.id, 'check-in');
    const r = await ctx.app.inject({ method: 'POST', url: `/worker/bookings/${s.bookingId}/ping`, headers: s.worker.auth, payload: { ...WHITEFIELD, accuracyM: 10 } });
    expect(r.statusCode).toBe(403);
  });
});

describe('PAY-12 supervisor marks attendance by hand', () => {
  it('needs the worker to confirm with a selfie before it can be approved', async () => {
    const s = await onShift(ctx, b);
    const at = (await ctx.db.query('SELECT starts_at, ends_at FROM shifts WHERE id = $1', [s.shift.id])).rows[0];
    const manual = (type: string, when: Date) => ctx.app.inject({
      method: 'POST', url: `/businesses/${b.businessId}/bookings/${s.bookingId}/manual`, headers: b.owner.auth,
      payload: { type, at: when.toISOString(), reason: 'Supervisor phone battery died at the gate' },
    });
    expect((await manual('check_in', at.starts_at)).statusCode).toBe(200);
    expect((await manual('check_out', new Date())).statusCode).toBe(200);
    const ts = (await ctx.db.query('SELECT id, status FROM timesheets WHERE booking_id = $1', [s.bookingId])).rows[0];
    expect(ts.status).toBe('awaiting_confirmation');
    expect((await ctx.app.inject({ method: 'POST', url: `/businesses/${b.businessId}/timesheets/${ts.id}/approve`, headers: b.owner.auth })).statusCode).toBe(409);

    const pending = (await ctx.app.inject({ method: 'GET', url: '/worker/attendance/pending', headers: s.worker.auth })).json();
    expect(pending).toHaveLength(2);
    // Someone else's face can't confirm.
    expect((await ctx.app.inject({ method: 'POST', url: `/worker/attendance/${pending[0].id}/confirm`, headers: s.worker.auth, payload: { selfie: { mockPersonId: 'x' } } })).statusCode).toBe(400);
    for (const p of pending) {
      await ctx.app.inject({ method: 'POST', url: `/worker/attendance/${p.id}/confirm`, headers: s.worker.auth, payload: { selfie: { mockPersonId: s.worker.personId } } });
    }
    expect((await ctx.db.query('SELECT status FROM timesheets WHERE id = $1', [ts.id])).rows[0].status).toBe('pending_approval');
  });

  it('a worker who never came can say so, and the business is flagged', async () => {
    const s = await onShift(ctx, b);
    const at = (await ctx.db.query('SELECT starts_at FROM shifts WHERE id = $1', [s.shift.id])).rows[0];
    await ctx.app.inject({ method: 'POST', url: `/businesses/${b.businessId}/bookings/${s.bookingId}/manual`, headers: b.owner.auth, payload: { type: 'check_in', at: at.starts_at.toISOString(), reason: 'Marked present by supervisor' } });
    const pending = (await ctx.app.inject({ method: 'GET', url: '/worker/attendance/pending', headers: s.worker.auth })).json();
    await ctx.app.inject({ method: 'POST', url: `/worker/attendance/${pending[0].id}/reject`, headers: s.worker.auth });
    expect(await flagsOf(b.businessId)).toContain('manual_attendance_disputed');
  });

  it('attendance records cannot be edited or deleted', async () => {
    await expect(ctx.db.query(`UPDATE attendance_events SET effective_at = now()`)).rejects.toThrow(/append-only/);
    await expect(ctx.db.query(`DELETE FROM attendance_events`)).rejects.toThrow(/append-only/);
  });
});
