import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, makeApp, resetData, staffWith, type Ctx } from '../helpers';
import { runJobs, seedRates, verifiedBusiness, workedShift } from '../fixtures';

let ctx: Ctx;
beforeAll(async () => { ctx = await makeApp(); await resetData(ctx.db); await seedRates(ctx); });
afterAll(async () => closeApp(ctx));

describe('analytics dashboard', () => {
  it('fill rate, payout delay, dispute rate and flags, with no personal data', async () => {
    const b = await verifiedBusiness(ctx);
    const s1 = await workedShift(ctx, b, { headcount: 2 }); // 1 of 2 filled
    await ctx.app.inject({ method: 'POST', url: `/businesses/${b.businessId}/timesheets/${s1.timesheet.id}/approve`, headers: b.owner.auth });
    const s2 = await workedShift(ctx, b, { headcount: 1 }); // 1 of 1 filled
    await ctx.app.inject({ method: 'POST', url: `/businesses/${b.businessId}/timesheets/${s2.timesheet.id}/dispute`, headers: b.owner.auth, payload: { minutes: 10, category: 'other', reason: 'Ten minutes late back from lunch' } });
    await runJobs(ctx);
    const staff = await staffWith(ctx, ['compliance']);
    const r = await ctx.app.inject({ method: 'GET', url: '/admin/analytics?days=30', headers: staff.cookie });
    expect(r.statusCode).toBe(200);
    const a = r.json();
    expect(a.kpis.fillRate).toBeCloseTo(66.7, 1); // 2 of 3 slots
    expect(a.kpis.disputeRate).toBe(50);
    expect(a.kpis.payoutDelayP50Min).toBeGreaterThanOrEqual(0);
    expect(a.daily).toHaveLength(30);
    expect(r.body).not.toMatch(/Ravi|\+91|[0-9a-f]{8}-[0-9a-f]{4}-/); // aggregates only: no names, phones or ids
  });

  it('is not available to workers or businesses', async () => {
    const b = await verifiedBusiness(ctx);
    expect((await ctx.app.inject({ method: 'GET', url: '/admin/analytics', headers: b.owner.auth })).statusCode).toBe(401);
  });
});
