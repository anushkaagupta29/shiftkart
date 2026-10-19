// PAY-03 late cancellations · PAY-11 turned away · strikes, limits and appeals · WRK-10 emergency
// exceptions · SAF-04 site pause · SAF-03 night shifts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, makeApp, resetData, staffWith, type Ctx } from '../helpers';
import { clock, istSlot, liveShift, onShift, runJobs, seedRates, startShiftAgo, verifiedBusiness, verifiedWorker, type Biz, type Worker } from '../fixtures';
import { accountBalance, shiftEscrow } from '../../src/ledger';

let ctx: Ctx;
let b: Biz;
beforeAll(async () => { ctx = await makeApp(); await resetData(ctx.db); await seedRates(ctx); b = await verifiedBusiness(ctx); });
afterAll(async () => closeApp(ctx));

const accept = (w: Worker, id: string) => ctx.app.inject({ method: 'POST', url: `/worker/shifts/${id}/accept`, headers: w.auth, payload: { nightConsent: true } });
const flagsOf = async (subject: string) => (await ctx.db.query(`SELECT rule_code FROM fraud_flags WHERE subject_id = $1 AND status = 'open'`, [subject])).rows.map((r) => r.rule_code);
const compOf = async (bookingId: string) => (await ctx.db.query('SELECT * FROM compensations WHERE booking_id = $1', [bookingId])).rows[0];
async function bookedShift(biz: Biz, startsInHours: number, w?: Worker) {
  const s = await liveShift(ctx, biz, { startsAt: istSlot(9, 9), endsAt: istSlot(9, 17) });
  const worker = w ?? (await verifiedWorker(ctx));
  const bk = (await accept(worker, s.id)).json();
  await startShiftAgo(ctx, s.id, -Math.round(startsInHours * 60));
  return { s, worker, bookingId: bk.bookingId as string };
}

describe('PAY-03 business cancels', () => {
  it('5 hours before: each booked worker gets 50% of shift pay from escrow; the rest is refunded', async () => {
    const { s, worker, bookingId } = await bookedShift(b, 5);
    const preview = (await ctx.app.inject({ method: 'GET', url: `/businesses/${b.businessId}/shifts/${s.id}/cancel-preview`, headers: b.owner.auth })).json();
    expect(preview).toMatchObject({ compensationPercent: 50, bookedWorkers: 1 });
    const r = await ctx.app.inject({ method: 'POST', url: `/businesses/${b.businessId}/shifts/${s.id}/cancel`, headers: b.owner.auth, payload: { reason: 'Client postponed the event' } });
    expect(r.json()).toMatchObject({ ok: true, compensationPaise: 37500 }); // 50% of ₹750
    expect(Number((await compOf(bookingId)).amount_paise)).toBe(37500);
    await runJobs(ctx);
    const p = (await ctx.db.query(`SELECT kind, status, amount_paise FROM payouts WHERE worker_id = $1`, [worker.userId])).rows;
    expect(p).toEqual([{ kind: 'compensation', status: 'paid', amount_paise: 37500 }]);
    expect(await accountBalance(ctx.db, shiftEscrow(s.id))).toBe(0);
    // A business cancellation never gives the worker a strike.
    expect((await ctx.db.query('SELECT count(*)::int AS n FROM strikes WHERE worker_id = $1', [worker.userId])).rows[0].n).toBe(0);
  });

  it('more than 24 hours before: no compensation, full refund', async () => {
    const { s, bookingId } = await bookedShift(b, 30);
    await ctx.app.inject({ method: 'POST', url: `/businesses/${b.businessId}/shifts/${s.id}/cancel`, headers: b.owner.auth, payload: { reason: 'Changed plans early' } });
    expect(Number((await compOf(bookingId)).amount_paise)).toBe(0);
    const refunds = (await ctx.db.query('SELECT sum(amount_paise)::bigint AS r FROM refunds WHERE shift_id = $1', [s.id])).rows[0].r;
    expect(refunds).toBe(Number(s.totalPaise));
  });

  it('three late cancellations in 30 days: flagged, and new shifts go to review', async () => {
    const nb = await verifiedBusiness(ctx);
    for (let i = 0; i < 3; i++) {
      const { s } = await bookedShift(nb, 3);
      await ctx.app.inject({ method: 'POST', url: `/businesses/${nb.businessId}/shifts/${s.id}/cancel`, headers: nb.owner.auth, payload: { reason: 'Cancelled again late' } });
    }
    expect(await flagsOf(nb.businessId)).toContain('late_cancel_pattern');
    const next = await ctx.app.inject({ method: 'POST', url: `/businesses/${nb.businessId}/shifts`, headers: nb.owner.auth, payload: (await import('../fixtures')).shiftBody(nb.siteId) });
    expect(next.json()).toMatchObject({ status: 'pending_review', reviewReasons: expect.arrayContaining(['late_cancel_pattern']) });
  });
});

describe('PAY-11 turned away at the gate', () => {
  it('a checked-in worker sent home gets max(4 h pay, 50%) plus travel allowance', async () => {
    const s = await onShift(ctx, b, { travelAllowancePaise: 3000 });
    await clock(ctx, s.worker, s.bookingId, s.shift.id, 'check-in');
    const r = await ctx.app.inject({ method: 'POST', url: `/businesses/${b.businessId}/bookings/${s.bookingId}/turn-away`, headers: b.owner.auth, payload: { reason: 'Stock did not arrive' } });
    expect(r.json()).toEqual({ status: 'turned_away', compensationPaise: 40000 + 3000 }); // 4h × ₹100 > 50% of ₹750
  });

  it('only workers who checked in can be turned away; a business cannot turn a checked-in worker into a no-show', async () => {
    const s = await onShift(ctx, b);
    expect((await ctx.app.inject({ method: 'POST', url: `/businesses/${b.businessId}/bookings/${s.bookingId}/turn-away`, headers: b.owner.auth, payload: { reason: 'Sent home early' } })).statusCode).toBe(409);
    await clock(ctx, s.worker, s.bookingId, s.shift.id, 'check-in');
    expect(ctx.app.authTable.some((r) => /no-show/.test(r.url))).toBe(false);
    await startShiftAgo(ctx, s.shift.id, 10 * 60);
    await runJobs(ctx);
    expect((await ctx.db.query('SELECT status FROM bookings WHERE id = $1', [s.bookingId])).rows[0].status).toBe('checked_in');
  });
});

describe('strikes, limits and appeals', () => {
  const cancel = (w: Worker, bookingId: string, emergency?: string) => ctx.app.inject({ method: 'POST', url: `/worker/bookings/${bookingId}/cancel`, headers: w.auth, payload: emergency ? { emergency: { reason: emergency } } : {} });

  it('late cancel = 1 point; 3 points = limited to 1 upcoming shift; 6 = on hold for review (never a permanent ban)', async () => {
    const w = await verifiedWorker(ctx);
    for (let i = 0; i < 3; i++) {
      const { bookingId } = await bookedShift(b, 5, w);
      expect((await cancel(w, bookingId)).json().strike).toMatchObject({ status: 'active', totalPoints: i + 1 });
    }
    let status = (await ctx.app.inject({ method: 'GET', url: '/worker/strikes', headers: w.auth })).json();
    expect(status).toMatchObject({ points: 3, level: 'limited' });
    const s1 = await liveShift(ctx, b, { startsAt: istSlot(11, 9), endsAt: istSlot(11, 17) });
    const s2 = await liveShift(ctx, b, { startsAt: istSlot(13, 9), endsAt: istSlot(13, 17) });
    expect((await accept(w, s1.id)).statusCode).toBe(201);
    expect((await accept(w, s2.id)).json().error.code).toBe('too_many_bookings');

    await ctx.db.query(`UPDATE bookings SET status = 'cancelled_worker' WHERE worker_id = $1 AND shift_id = $2`, [w.userId, s1.id]); // free the one slot
    for (let i = 0; i < 3; i++) {
      const { bookingId } = await bookedShift(b, 5, w);
      expect(bookingId).toBeTruthy();
      await cancel(w, bookingId);
    }
    status = (await ctx.app.inject({ method: 'GET', url: '/worker/strikes', headers: w.auth })).json();
    expect(status).toMatchObject({ points: 6, level: 'on_hold' });
    expect((await accept(w, s2.id)).statusCode).toBe(403);
    expect(await flagsOf(w.userId)).toContain('strike_hold_review');
    // The worker can still log in and appeal.
    const appeal = await ctx.app.inject({ method: 'POST', url: `/worker/strikes/${status.items[0].id}/appeal`, headers: w.auth, payload: { reason: 'My child was in hospital that day' } });
    expect(appeal.json().status).toBe('appealed');
    expect((await ctx.app.inject({ method: 'POST', url: `/worker/strikes/${status.items[0].id}/appeal`, headers: w.auth, payload: { reason: 'Appealing a second time' } })).statusCode).toBe(409);
    const ops = await staffWith(ctx, ['ops_disputes']);
    await ctx.app.inject({ method: 'POST', url: `/admin/appeals/${status.items[0].id}/decide`, headers: ops.cookie, payload: { decision: 'overturn', reason: 'Hospital receipt provided' } });
    expect((await ctx.app.inject({ method: 'GET', url: '/worker/strikes', headers: w.auth })).json()).toMatchObject({ points: 5, level: 'limited' });
  });

  it('cancelling early enough is free', async () => {
    const w = await verifiedWorker(ctx);
    const { bookingId } = await bookedShift(b, 20, w);
    expect((await cancel(w, bookingId)).json().strike).toBeNull();
  });

  it('WRK-10: two emergencies in 90 days are excused; the third becomes an appeal for a person to review', async () => {
    const w = await verifiedWorker(ctx);
    const statuses = [];
    for (let i = 0; i < 3; i++) {
      const { bookingId } = await bookedShift(b, 4, w);
      statuses.push((await cancel(w, bookingId, 'Family emergency at home')).json().strike.status);
    }
    expect(statuses).toEqual(['excused', 'excused', 'appealed']);
    const appeals = (await ctx.app.inject({ method: 'GET', url: '/admin/appeals', headers: (await staffWith(ctx, ['ops_disputes'])).cookie })).json();
    expect(appeals.some((a: { workerId: string; emergency: boolean }) => a.workerId === w.userId && a.emergency)).toBe(true);
  });

  it('a no-show earns 2 points when the shift settles', async () => {
    const { s, worker } = await bookedShift(b, 1);
    await startShiftAgo(ctx, s.id, 12 * 60);
    await runJobs(ctx);
    const k = (await ctx.db.query(`SELECT kind, points, status FROM strikes WHERE worker_id = $1`, [worker.userId])).rows;
    expect(k).toEqual([{ kind: 'no_show', points: 2, status: 'active' }]);
    expect((await ctx.db.query('SELECT reliability_score FROM worker_profiles WHERE user_id = $1', [worker.userId])).rows[0].reliability_score).toBe(80);
  });
});

describe('SAF-04 pausing a site', () => {
  it('cancels its upcoming shifts and compensates booked workers', async () => {
    const nb = await verifiedBusiness(ctx);
    const { s, bookingId } = await bookedShift(nb, 4);
    const safety = await staffWith(ctx, ['ops_safety']);
    const r = await ctx.app.inject({ method: 'POST', url: `/admin/sites/${nb.siteId}/pause`, headers: safety.cookie, payload: { reason: 'Harassment report under investigation' } });
    expect(r.json()).toMatchObject({ status: 'paused', shiftsCancelled: 1 });
    expect((await ctx.db.query('SELECT status, cancelled_by FROM shifts WHERE id = $1', [s.id])).rows[0]).toEqual({ status: 'cancelled', cancelled_by: 'site_paused' });
    expect((await compOf(bookingId)).reason).toBe('site_paused');
    expect(Number((await compOf(bookingId)).amount_paise)).toBe(37500);
  });
});

describe('SAF-03 night shifts', () => {
  it('need the business to promise transport, and each worker to agree', async () => {
    const night = { startsAt: istSlot(15, 22), endsAt: istSlot(16, 6), breakMinutes: 0 };
    const noTransport = await ctx.app.inject({ method: 'POST', url: `/businesses/${b.businessId}/shifts`, headers: b.owner.auth, payload: (await import('../fixtures')).shiftBody(b.siteId, night) });
    expect(noTransport.json().error.code).toBe('night_transport_required');
    const s = await liveShift(ctx, b, { ...night, nightTransportAttested: true });
    const w = await verifiedWorker(ctx);
    const noConsent = await ctx.app.inject({ method: 'POST', url: `/worker/shifts/${s.id}/accept`, headers: w.auth });
    expect(noConsent.json().error.code).toBe('night_consent_required');
    expect((await accept(w, s.id)).statusCode).toBe(201);
    expect((await ctx.db.query('SELECT night_consent_at FROM bookings WHERE worker_id = $1 AND shift_id = $2', [w.userId, s.id])).rows[0].night_consent_at).not.toBeNull();
  });
});
