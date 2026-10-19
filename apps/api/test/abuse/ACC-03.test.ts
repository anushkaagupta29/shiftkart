// ACC-03: stolen refresh token replay.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, makeApp, resetData, signUp, type Ctx } from '../helpers';

let ctx: Ctx;
beforeAll(async () => { ctx = await makeApp(); await resetData(ctx.db); });
afterAll(async () => closeApp(ctx));

const refresh = (refreshToken: string) => ctx.app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken } });

describe('ACC-03 refresh token reuse', () => {
  it('reusing an old refresh token revokes the whole family', async () => {
    const w = await signUp(ctx, 'worker');
    const r1 = await refresh(w.refreshToken);
    expect(r1.statusCode).toBe(200);
    const legit = r1.json();

    // Attacker replays the original token.
    expect((await refresh(w.refreshToken)).statusCode).toBe(401);

    // The legitimate user's newer tokens are now dead too.
    expect((await ctx.app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${legit.accessToken}` } })).statusCode).toBe(401);
    expect((await refresh(legit.refreshToken)).statusCode).toBe(401);

    const logged = await ctx.db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'session.refresh_reuse_detected' AND target_id = $1`, [w.userId]);
    expect(logged.rows[0].n).toBe(1);
  });

  it('the old access token stops working after a refresh', async () => {
    const w = await signUp(ctx, 'worker');
    await refresh(w.refreshToken);
    expect((await ctx.app.inject({ method: 'GET', url: '/me', headers: w.auth })).statusCode).toBe(401);
  });

  it('parallel refreshes with one token yield at most one new session', async () => {
    const w = await signUp(ctx, 'worker');
    const results = await Promise.all(Array.from({ length: 5 }, () => refresh(w.refreshToken)));
    expect(results.filter((r) => r.statusCode === 200).length).toBeLessThanOrEqual(1);
  });

  it('expired access tokens are rejected', async () => {
    const w = await signUp(ctx, 'worker');
    await ctx.db.query(`UPDATE sessions SET access_expires_at = now() - interval '1 second' WHERE user_id = $1`, [w.userId]);
    expect((await ctx.app.inject({ method: 'GET', url: '/me', headers: w.auth })).statusCode).toBe(401);
  });
});
