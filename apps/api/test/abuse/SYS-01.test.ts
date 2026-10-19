// SYS-01: 200 people tap "accept" on the last slot at the same moment. Exactly one gets it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, makeApp, resetData, type Ctx } from '../helpers';
import { bulkVerifiedWorkers, istSlot, liveShift, seedRates, verifiedBusiness, type Biz } from '../fixtures';

let ctx: Ctx;
let b: Biz;
let workers: Awaited<ReturnType<typeof bulkVerifiedWorkers>>;
beforeAll(async () => {
  ctx = await makeApp();
  await resetData(ctx.db);
  await seedRates(ctx);
  b = await verifiedBusiness(ctx);
  workers = await bulkVerifiedWorkers(ctx, 200);
}, 120_000);
afterAll(async () => closeApp(ctx));

const acceptAll = (shiftId: string) =>
  Promise.all(workers.map((w) => ctx.app.inject({ method: 'POST', url: `/worker/shifts/${shiftId}/accept`, headers: w.auth })));

describe('SYS-01 no overbooking', () => {
  it('headcount 1, 200 concurrent accepts → exactly 1 booking', async () => {
    const s = await liveShift(ctx, b, { headcount: 1 });
    const res = await acceptAll(s.id);
    const codes = res.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    expect(codes.filter((c) => c === 409)).toHaveLength(199);
    expect(res.find((r) => r.statusCode === 409)!.json().error.code).toBe('shift_full');
    const db = await ctx.db.query(`SELECT filled_count, (SELECT count(*)::int FROM bookings WHERE shift_id = $1 AND status = 'confirmed') AS n FROM shifts WHERE id = $1`, [s.id]);
    expect(db.rows[0]).toEqual({ filled_count: 1, n: 1 });
  }, 60_000);

  it('headcount 30, 200 concurrent accepts → exactly 30 bookings', async () => {
    const s = await liveShift(ctx, b, { headcount: 30, startsAt: istSlot(4, 9), endsAt: istSlot(4, 17) });
    const res = await acceptAll(s.id);
    expect(res.filter((r) => r.statusCode === 201)).toHaveLength(30);
    const db = await ctx.db.query(`SELECT filled_count, (SELECT count(*)::int FROM bookings WHERE shift_id = $1 AND status = 'confirmed') AS n FROM shifts WHERE id = $1`, [s.id]);
    expect(db.rows[0]).toEqual({ filled_count: 30, n: 30 });
  }, 60_000);

  it('the database itself refuses filled_count above headcount', async () => {
    const s = await liveShift(ctx, b, { headcount: 1, startsAt: istSlot(6, 9), endsAt: istSlot(6, 17) });
    await expect(ctx.db.query('UPDATE shifts SET filled_count = 2 WHERE id = $1', [s.id])).rejects.toThrow(/check constraint/);
  });
});
