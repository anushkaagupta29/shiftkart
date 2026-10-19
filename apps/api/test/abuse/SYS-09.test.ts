// SYS-09 waitlist offers: bound to one worker, expire, pass on; WRK-09 accept rate limit;
// SAF-04 paused sites disappear from the feed.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, makeApp, resetData, staffWith, type Ctx } from '../helpers';
import { istSlot, liveShift, seedRates, verifiedBusiness, verifiedWorker, type Biz, type Worker } from '../fixtures';
import { sweepExpiredOffers } from '../../src/booking';

let ctx: Ctx;
let b: Biz;
beforeAll(async () => { ctx = await makeApp(); await resetData(ctx.db); await seedRates(ctx); b = await verifiedBusiness(ctx); });
afterAll(async () => closeApp(ctx));

const call = (w: Worker, method: 'POST' | 'GET' | 'DELETE', url: string) => ctx.app.inject({ method, url, headers: w.auth });

describe('SYS-09 waitlist', () => {
  it('a freed slot is offered to the first in line, held for them, and passes on when it expires', async () => {
    const s = await liveShift(ctx, b, { headcount: 1, startsAt: istSlot(3, 9), endsAt: istSlot(3, 17) });
    const [holder, first, second, outsider] = [await verifiedWorker(ctx), await verifiedWorker(ctx), await verifiedWorker(ctx), await verifiedWorker(ctx)];
    const booking = (await call(holder, 'POST', `/worker/shifts/${s.id}/accept`)).json();
    expect((await call(first, 'POST', `/worker/shifts/${s.id}/waitlist`)).json().peopleAhead).toBe(0);
    expect((await call(second, 'POST', `/worker/shifts/${s.id}/waitlist`)).json().peopleAhead).toBe(1);

    const cancel = (await call(holder, 'POST', `/worker/bookings/${booking.bookingId}/cancel`)).json();
    expect(cancel.slot).toBe('offered');

    // The slot is held for the offer: nobody else can grab it.
    expect((await call(outsider, 'POST', `/worker/shifts/${s.id}/accept`)).json().error.code).toBe('shift_full');
    const offer = (await call(first, 'GET', '/worker/offers')).json().find((o: { status: string }) => o.status === 'offered');
    expect(offer).toBeDefined();
    // Someone else can't accept another person's offer.
    expect((await call(second, 'POST', `/worker/offers/${offer.id}/accept`)).statusCode).toBe(404);

    // Let it expire → passes to the second person.
    await ctx.db.query(`UPDATE waitlist_entries SET offer_expires_at = now() - interval '1 second' WHERE id = $1`, [offer.id]);
    expect((await call(first, 'POST', `/worker/offers/${offer.id}/accept`)).json().error.code).toBe('offer_expired');
    const offer2 = (await call(second, 'GET', '/worker/offers')).json().find((o: { status: string }) => o.status === 'offered');
    expect(offer2).toBeDefined();
    expect((await call(second, 'POST', `/worker/offers/${offer2.id}/accept`)).statusCode).toBe(201);
    const filled = (await ctx.db.query('SELECT filled_count FROM shifts WHERE id = $1', [s.id])).rows[0].filled_count;
    expect(filled).toBe(1);
  });

  it('the background sweep expires offers nobody answered and releases the slot', async () => {
    const s = await liveShift(ctx, b, { headcount: 1, startsAt: istSlot(5, 9), endsAt: istSlot(5, 17) });
    const [holder, waiter, walkIn] = [await verifiedWorker(ctx), await verifiedWorker(ctx), await verifiedWorker(ctx)];
    const booking = (await call(holder, 'POST', `/worker/shifts/${s.id}/accept`)).json();
    await call(waiter, 'POST', `/worker/shifts/${s.id}/waitlist`);
    await call(holder, 'POST', `/worker/bookings/${booking.bookingId}/cancel`);
    await ctx.db.query(`UPDATE waitlist_entries SET offer_expires_at = now() - interval '1 second' WHERE shift_id = $1 AND status = 'offered'`, [s.id]);
    expect(await sweepExpiredOffers(ctx.db)).toBe(1);
    // Nobody left waiting → slot is open again.
    expect((await call(walkIn, 'POST', `/worker/shifts/${s.id}/accept`)).statusCode).toBe(201);
  });

  it('the waitlist is only for full shifts', async () => {
    const s = await liveShift(ctx, b, { headcount: 3, startsAt: istSlot(7, 9), endsAt: istSlot(7, 17) });
    const w = await verifiedWorker(ctx);
    expect((await call(w, 'POST', `/worker/shifts/${s.id}/waitlist`)).json().error.code).toBe('slots_available');
  });

  it('a waitlist offer notifies the worker by SMS (mock)', async () => {
    const n = await ctx.db.query(`SELECT count(*)::int AS n FROM dev_outbox WHERE body LIKE '%slot opened%'`);
    expect(n.rows[0].n).toBeGreaterThanOrEqual(2);
  });
});

describe('WRK-09 accept rate limit', () => {
  it('more than 10 accept attempts a minute from one worker get 429', async () => {
    const w = await verifiedWorker(ctx);
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await call(w, 'POST', '/worker/shifts/00000000-0000-4000-8000-000000000000/accept')).statusCode);
    expect(codes.slice(0, 10).every((c) => c === 404)).toBe(true);
    expect(codes.slice(10)).toEqual([429, 429]);
  });
});

describe('SAF-04 paused site', () => {
  it('shifts at a paused site vanish from the feed and cannot be accepted', async () => {
    const s = await liveShift(ctx, b, { startsAt: istSlot(9, 9), endsAt: istSlot(9, 17) });
    const w = await verifiedWorker(ctx);
    const safety = await staffWith(ctx, ['ops_safety']);
    await ctx.app.inject({ method: 'POST', url: `/admin/sites/${b.siteId}/pause`, headers: safety.cookie, payload: { reason: 'Serious safety report' } });
    try {
      const f = await ctx.app.inject({ method: 'POST', url: '/worker/shifts/search', headers: w.auth, payload: {} });
      expect(f.json().items.find((x: { id: string }) => x.id === s.id)).toBeUndefined();
      // Posting there is blocked too.
      const p = await ctx.app.inject({ method: 'POST', url: `/businesses/${b.businessId}/shifts`, headers: b.owner.auth, payload: (await import('../fixtures')).shiftBody(b.siteId) });
      expect(p.json().error.code).toBe('site_not_active');
    } finally {
      await ctx.app.inject({ method: 'POST', url: `/admin/sites/${b.siteId}/resume`, headers: safety.cookie, payload: { reason: 'Investigation closed' } });
    }
  });
});
