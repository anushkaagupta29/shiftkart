// SYS-02: overlapping shifts and rest gaps, enforced by a database constraint even under races.
// Also SYS-07 (cross-midnight shifts) and WRK-08 (slot hoarding).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, makeApp, resetData, type Ctx } from '../helpers';
import { istSlot, liveShift, seedRates, verifiedBusiness, verifiedWorker, type Biz } from '../fixtures';

let ctx: Ctx;
let b: Biz;
beforeAll(async () => { ctx = await makeApp(); await resetData(ctx.db); await seedRates(ctx); b = await verifiedBusiness(ctx); });
afterAll(async () => closeApp(ctx));

// nightConsent is required for night shifts (SPEC §6.10) and harmless for day shifts.
const accept = (w: { auth: object }, id: string) => ctx.app.inject({ method: 'POST', url: `/worker/shifts/${id}/accept`, headers: w.auth as Record<string, string>, payload: { nightConsent: true } });

describe('SYS-02 overlaps and rest', () => {
  it('parallel accepts of two overlapping shifts: only one succeeds', async () => {
    const w = await verifiedWorker(ctx);
    const a = await liveShift(ctx, b, { startsAt: istSlot(3, 9), endsAt: istSlot(3, 17) });
    const c = await liveShift(ctx, b, { startsAt: istSlot(3, 12), endsAt: istSlot(3, 20) });
    const [r1, r2] = await Promise.all([accept(w, a.id), accept(w, c.id)]);
    expect([r1.statusCode, r2.statusCode].sort()).toEqual([201, 409]);
    // The losing request gave its slot back.
    const filled = await ctx.db.query('SELECT sum(filled_count)::int AS n FROM shifts WHERE id = ANY($1)', [[a.id, c.id]]);
    expect(filled.rows[0].n).toBe(1);
  });

  it('back-to-back shifts with less than the rest gap are refused', async () => {
    const w = await verifiedWorker(ctx);
    const day = await liveShift(ctx, b, { startsAt: istSlot(5, 8), endsAt: istSlot(5, 14) });
    const evening = await liveShift(ctx, b, { startsAt: istSlot(5, 18), endsAt: istSlot(5, 22), nightTransportAttested: true }); // 4h gap < 8h
    expect((await accept(w, day.id)).statusCode).toBe(201);
    const r = await accept(w, evening.id);
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('overlap_or_rest_gap');
  });

  it('SYS-07: a 22:00–06:00 IST night shift is 8 hours and counts on its start day', async () => {
    const w = await verifiedWorker(ctx);
    const night = await liveShift(ctx, b, { startsAt: istSlot(7, 22), endsAt: istSlot(8, 6), breakMinutes: 0, nightTransportAttested: true });
    expect(night.cost.paidMinutes).toBe(480);
    expect((await accept(w, night.id)).statusCode).toBe(201);
    // Next day 16:00-20:00 is fine (10h rest after 06:00).
    const next = await liveShift(ctx, b, { startsAt: istSlot(8, 16), endsAt: istSlot(8, 20), breakMinutes: 0 });
    expect((await accept(w, next.id)).statusCode).toBe(201);
  });

  it('daily hours cap', async () => {
    const w = await verifiedWorker(ctx);
    await ctx.db.query(`INSERT INTO policy_config (key, value, reason, effective_from) VALUES ('booking.max_hours_day', '6', 'test', now() - interval '1 second')`);
    try {
      const s = await liveShift(ctx, b, { startsAt: istSlot(9, 9), endsAt: istSlot(9, 17) });
      const r = await accept(w, s.id);
      expect(r.json().error.code).toBe('daily_hours_cap');
    } finally {
      await ctx.db.query(`INSERT INTO policy_config (key, value, reason, effective_from) VALUES ('booking.max_hours_day', '12', 'test reset', now())`);
    }
  });

  it('WRK-08: a new worker can hold at most 2 upcoming shifts', async () => {
    const w = await verifiedWorker(ctx);
    const ids = [];
    for (const d of [10, 12, 14]) ids.push((await liveShift(ctx, b, { startsAt: istSlot(d, 9), endsAt: istSlot(d, 17) })).id);
    expect((await accept(w, ids[0])).statusCode).toBe(201);
    expect((await accept(w, ids[1])).statusCode).toBe(201);
    const third = await accept(w, ids[2]);
    expect(third.statusCode).toBe(409);
    expect(third.json().error.code).toBe('too_many_bookings');
  });

  it('cannot book the same shift twice', async () => {
    const w = await verifiedWorker(ctx);
    const s = await liveShift(ctx, b, { startsAt: istSlot(16, 9), endsAt: istSlot(16, 17) });
    expect((await accept(w, s.id)).statusCode).toBe(201);
    expect((await accept(w, s.id)).statusCode).toBe(409);
  });
});
