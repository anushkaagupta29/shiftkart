// INT-05: bulk export by a disgruntled employee. List endpoints are capped.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, makeApp, resetData, staffWith, type Ctx } from '../helpers';

let ctx: Ctx;
beforeAll(async () => { ctx = await makeApp(); await resetData(ctx.db); });
afterAll(async () => closeApp(ctx));

describe('INT-05 page size clamp', () => {
  it('clamps pageSize to 100 on user and audit lists', async () => {
    const s = await staffWith(ctx, ['compliance']);
    for (const url of ['/admin/users?pageSize=100000', '/admin/audit?pageSize=100000']) {
      const r = await ctx.app.inject({ method: 'GET', url, headers: s.cookie });
      expect(r.statusCode).toBe(200);
      expect(r.json().pageSize).toBe(100);
    }
  });

  it('disabling a staff member ends their session immediately', async () => {
    const sa = await staffWith(ctx, ['super_admin']);
    const leaver = await staffWith(ctx, ['ops_support']);
    expect((await ctx.app.inject({ method: 'GET', url: '/admin/users', headers: leaver.cookie })).statusCode).toBe(200);
    const r = await ctx.app.inject({ method: 'POST', url: `/admin/staff/${leaver.staffId}/disable`, headers: sa.cookie, payload: { reason: 'Left the company' } });
    expect(r.statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: '/admin/users', headers: leaver.cookie })).statusCode).toBe(401);
  });
});
