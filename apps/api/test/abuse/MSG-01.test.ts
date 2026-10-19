// MSG-01: scraping and IDOR. Users only reach their own data; IDs can't be probed.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, makeApp, resetData, signUp, staffWith, type Ctx } from '../helpers';

let ctx: Ctx;
beforeAll(async () => { ctx = await makeApp(); await resetData(ctx.db); });
afterAll(async () => closeApp(ctx));

describe('MSG-01 cross-account access', () => {
  it("a business can't read another business or its members", async () => {
    const a = await signUp(ctx, 'business');
    const b = await signUp(ctx, 'business');
    const bizB = (await ctx.app.inject({ method: 'POST', url: '/businesses', headers: b.auth, payload: { legalName: 'B Corp' } })).json();
    for (const url of [`/businesses/${bizB.id}`, `/businesses/${bizB.id}/members`]) {
      const r = await ctx.app.inject({ method: 'GET', url, headers: a.auth });
      expect(r.statusCode).toBe(404); // same as a non-existent id: no existence oracle
    }
    const nonexistent = await ctx.app.inject({ method: 'GET', url: `/businesses/${randomUUID()}`, headers: a.auth });
    expect(nonexistent.statusCode).toBe(404);
    const list = (await ctx.app.inject({ method: 'GET', url: '/businesses', headers: a.auth })).json();
    expect(list).toEqual([]);
  });

  it("a worker can't use business routes", async () => {
    const w = await signUp(ctx, 'worker');
    expect((await ctx.app.inject({ method: 'GET', url: '/businesses', headers: w.auth })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'POST', url: '/businesses', headers: w.auth, payload: { legalName: 'Fake' } })).statusCode).toBe(403);
  });

  it("a user can't sign out someone else's device", async () => {
    const a = await signUp(ctx, 'worker');
    const b = await signUp(ctx, 'worker');
    const bSessions = (await ctx.app.inject({ method: 'GET', url: '/me/sessions', headers: b.auth })).json();
    const r = await ctx.app.inject({ method: 'DELETE', url: `/me/sessions/${bSessions[0].id}`, headers: a.auth });
    expect(r.statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'GET', url: '/me', headers: b.auth })).statusCode).toBe(200);
  });

  it('user tokens never open admin routes, staff cookies never open user routes', async () => {
    const w = await signUp(ctx, 'worker');
    const staff = await staffWith(ctx, ['ops_support']);
    expect((await ctx.app.inject({ method: 'GET', url: '/admin/users', headers: w.auth })).statusCode).toBe(401);
    expect((await ctx.app.inject({ method: 'GET', url: '/me', headers: staff.cookie })).statusCode).toBe(401);
  });

  it('IDs are UUIDs, not guessable sequences', async () => {
    const w = await signUp(ctx, 'worker');
    expect(w.userId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
