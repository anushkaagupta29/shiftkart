// INT-02: support staff can't see sensitive personal data; revealing it is restricted and audited.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, makeApp, resetData, signUp, staffWith, type Ctx } from '../helpers';

let ctx: Ctx;
beforeAll(async () => { ctx = await makeApp(); await resetData(ctx.db); });
afterAll(async () => closeApp(ctx));

describe('INT-02 masked personal data', () => {
  it('support sees masked phones only, in lists, search and detail', async () => {
    const w = await signUp(ctx, 'worker');
    const support = await staffWith(ctx, ['ops_support']);
    const local = w.phone.slice(3);
    for (const res of [
      await ctx.app.inject({ method: 'GET', url: '/admin/users', headers: support.cookie }),
      await ctx.app.inject({ method: 'POST', url: '/admin/users/search', headers: support.cookie, payload: { phone: w.phone } }),
      await ctx.app.inject({ method: 'GET', url: `/admin/users/${w.userId}`, headers: support.cookie }),
    ]) {
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain(local);
      expect(res.body).not.toContain('phone_enc');
      expect(res.body).toContain(`******${local.slice(-4)}`);
    }
  });

  it('support cannot reveal a phone; safety can, only with a reason, and it is logged', async () => {
    const w = await signUp(ctx, 'worker');
    const support = await staffWith(ctx, ['ops_support']);
    const safety = await staffWith(ctx, ['ops_safety']);
    const url = `/admin/users/${w.userId}/reveal-phone`;

    expect((await ctx.app.inject({ method: 'POST', url, headers: support.cookie, payload: { reason: 'just curious' } })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'POST', url, headers: safety.cookie, payload: {} })).statusCode).toBe(400);

    const ok = await ctx.app.inject({ method: 'POST', url, headers: safety.cookie, payload: { reason: 'SOS follow-up, ticket 42' } });
    expect(ok.json().phone).toBe(w.phone);
    const logged = await ctx.db.query(`SELECT * FROM audit_log WHERE action = 'user.phone_revealed' AND target_id = $1`, [w.userId]);
    expect(logged.rows).toHaveLength(1);
    expect(logged.rows[0]).toMatchObject({ actor_id: safety.staffId, reason: 'SOS follow-up, ticket 42' });
    // The audit row itself never contains the phone number.
    expect(JSON.stringify(logged.rows[0])).not.toContain(w.phone.slice(3));
  });
});
