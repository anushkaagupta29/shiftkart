// INT-06 wage rates and policy values change only with a second person, never backdated.
// INT-02 (Phase 2 part) payout details visible to finance only, masked.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, makeApp, resetData, staffWith, type Ctx } from '../helpers';
import { seedRates, verifiedWorker } from '../fixtures';

let ctx: Ctx;
beforeAll(async () => { ctx = await makeApp(); await resetData(ctx.db); await seedRates(ctx); });
afterAll(async () => closeApp(ctx));

const tomorrow = () => new Date(Date.now() + 330 * 60_000 + 86400_000).toISOString().slice(0, 10);

describe('INT-06 minimum wage table', () => {
  it('a proposed rate needs a different compliance officer to approve it', async () => {
    const c1 = await staffWith(ctx, ['compliance']);
    const c2 = await staffWith(ctx, ['compliance']);
    const p = await ctx.app.inject({
      method: 'POST', url: '/admin/wage-rates', headers: c1.cookie,
      payload: { stateCode: 'KA', zone: 'A', wageCategory: 'unskilled', basicPaisePerDay: 50000, vdaPaisePerDay: 0, effectiveFrom: tomorrow(), sourceRef: 'Test notification', reason: 'Testing maker-checker' },
    });
    expect(p.statusCode).toBe(201);
    const self = await ctx.app.inject({ method: 'POST', url: `/admin/wage-rates/${p.json().id}/decide`, headers: c1.cookie, payload: { decision: 'approve', reason: 'Approving my own' } });
    expect(self.statusCode).toBe(403);
    const ok = await ctx.app.inject({ method: 'POST', url: `/admin/wage-rates/${p.json().id}/decide`, headers: c2.cookie, payload: { decision: 'reject', reason: 'Lower than current rate' } });
    expect(ok.json().status).toBe('rejected');
  });

  it('cannot be backdated, and amounts cannot be edited after the fact', async () => {
    const c1 = await staffWith(ctx, ['compliance']);
    const r = await ctx.app.inject({
      method: 'POST', url: '/admin/wage-rates', headers: c1.cookie,
      payload: { stateCode: 'KA', zone: 'A', wageCategory: 'unskilled', basicPaisePerDay: 50000, vdaPaisePerDay: 0, effectiveFrom: '2020-01-01', sourceRef: 'Old notification', reason: 'Backdating attempt' },
    });
    expect(r.json().error.code).toBe('backdated');
    await expect(ctx.db.query(`UPDATE min_wage_rates SET basic_paise_per_day = 1`)).rejects.toThrow(/frozen/);
    await expect(ctx.db.query(`DELETE FROM min_wage_rates`)).rejects.toThrow(/cannot be deleted/);
  });

  it('only compliance can propose rates', async () => {
    const f = await staffWith(ctx, ['finance']);
    const r = await ctx.app.inject({ method: 'POST', url: '/admin/wage-rates', headers: f.cookie, payload: {} });
    expect(r.statusCode).toBe(403);
  });
});

describe('policy changes are two-person', () => {
  it('requested by one, approved by another, then takes effect', async () => {
    await ctx.db.query(`INSERT INTO policy_config (key, value, reason, effective_from) VALUES ('fee.platform_bp', '1500', 'seed', now() - interval '1 day')`);
    const c1 = await staffWith(ctx, ['compliance']);
    const c2 = await staffWith(ctx, ['compliance']);
    const bad = await ctx.app.inject({ method: 'POST', url: '/admin/policy/requests', headers: c1.cookie, payload: { key: 'fee.platform_bp', value: 'twenty', reason: 'Type check test' } });
    expect(bad.json().error.code).toBe('type_mismatch');
    const req = await ctx.app.inject({ method: 'POST', url: '/admin/policy/requests', headers: c1.cookie, payload: { key: 'fee.platform_bp', value: 1200, reason: 'Festive season promo' } });
    expect((await ctx.app.inject({ method: 'POST', url: `/admin/policy/requests/${req.json().id}/decide`, headers: c1.cookie, payload: { decision: 'approve', reason: 'Approving my own request' } })).statusCode).toBe(403);
    await ctx.app.inject({ method: 'POST', url: `/admin/policy/requests/${req.json().id}/decide`, headers: c2.cookie, payload: { decision: 'approve', reason: 'Approved by finance head' } });
    const v = await ctx.db.query(`SELECT value FROM policy_config WHERE key = 'fee.platform_bp' ORDER BY effective_from DESC LIMIT 1`);
    expect(v.rows[0].value).toBe(1200);
  });
});

describe('INT-02 payout details', () => {
  it('support sees no payout data; finance sees only the masked form', async () => {
    const w = await verifiedWorker(ctx, { vpa: 'ravi.kumar99@okaxis' });
    const support = await staffWith(ctx, ['ops_support']);
    const finance = await staffWith(ctx, ['finance', 'ops_support']);
    const s = (await ctx.app.inject({ method: 'GET', url: `/admin/users/${w.userId}`, headers: support.cookie }));
    expect(s.json().payout).toBeUndefined();
    expect(s.body).not.toContain('ravi.kumar99');
    const f = (await ctx.app.inject({ method: 'GET', url: `/admin/users/${w.userId}`, headers: finance.cookie }));
    expect(f.json().payout.display).toBe('ra****@okaxis');
    expect(f.body).not.toContain('ravi.kumar99');
  });
});
