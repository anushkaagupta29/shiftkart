// The Phase 2 happy path end to end through the API: business verified → shift posted → funded →
// worker onboarded → sees the shift → accepts it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, makeApp, resetData, type Ctx } from '../helpers';
import { fund, postShift, seedRates, verifiedBusiness, verifiedWorker } from '../fixtures';
import { accountBalance, shiftEscrow } from '../../src/ledger';

let ctx: Ctx;
beforeAll(async () => { ctx = await makeApp(); await resetData(ctx.db); await seedRates(ctx); });
afterAll(async () => closeApp(ctx));

describe('Phase 2 journey', () => {
  it('post → fund → live → worker accepts', async () => {
    const b = await verifiedBusiness(ctx);

    const preview = await ctx.app.inject({ method: 'POST', url: `/businesses/${b.businessId}/shifts/preview`, headers: b.owner.auth, payload: (await import('../fixtures')).shiftBody(b.siteId) });
    expect(preview.statusCode).toBe(200);
    const shift = await postShift(ctx, b);
    expect(shift.status).toBe('pending_funding');
    expect(shift.totalPaise).toBe(preview.json().cost.totalPaise);
    // 7.5 h × ₹100 × 5 = ₹3,750; meal ₹250; fee 15% = ₹562.50; GST 18% on fee = ₹101.25
    expect(shift.cost).toMatchObject({ workerPayTotalPaise: 375000, allowancesTotalPaise: 25000, feePaise: 56250, gstOnFeePaise: 10125, totalPaise: 466375 });

    const w = await verifiedWorker(ctx);
    // Not visible before funding.
    let feed = (await ctx.app.inject({ method: 'POST', url: '/worker/shifts/search', headers: w.auth, payload: {} })).json();
    expect(feed.items.find((s: { id: string }) => s.id === shift.id)).toBeUndefined();

    const { webhook } = await fund(ctx, b, shift.id);
    expect(webhook.result.outcome).toBe('captured');
    expect(await accountBalance(ctx.db, shiftEscrow(shift.id))).toBe(466375);

    feed = (await ctx.app.inject({ method: 'POST', url: '/worker/shifts/search', headers: w.auth, payload: {} })).json();
    const seen = feed.items.find((s: { id: string }) => s.id === shift.id);
    expect(seen).toMatchObject({ slotsLeft: 5, eligible: true, pay: { hourlyPaise: 10000, totalPaise: 75000, takeHomePaise: 80000 } });
    expect(seen.address).toBeTruthy();

    const acc = await ctx.app.inject({ method: 'POST', url: `/worker/shifts/${shift.id}/accept`, headers: w.auth });
    expect(acc.statusCode).toBe(201);
    const detail = (await ctx.app.inject({ method: 'GET', url: `/businesses/${b.businessId}/shifts/${shift.id}`, headers: b.owner.auth })).json();
    expect(detail.filled).toBe(1);
    expect(detail.roster).toEqual([expect.objectContaining({ firstName: 'Ravi', status: 'confirmed' })]);
    // BIZ-06: the roster has no phone, no surname, no location.
    expect(JSON.stringify(detail.roster)).not.toMatch(/Kumar|\+91|lat|lng/);

    const bookings = (await ctx.app.inject({ method: 'GET', url: '/worker/bookings', headers: w.auth })).json();
    expect(bookings).toHaveLength(1);
  });
});
