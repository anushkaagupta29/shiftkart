// ACC-04: an ex-supervisor keeps access after leaving.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, fakePhone, makeApp, resetData, signUp, type Ctx } from '../helpers';

let ctx: Ctx;
beforeAll(async () => { ctx = await makeApp(); await resetData(ctx.db); });
afterAll(async () => closeApp(ctx));

describe('ACC-04 removed members lose access immediately', () => {
  it('owner adds a supervisor, removes them, and their next request fails', async () => {
    const owner = await signUp(ctx, 'business');
    const biz = (await ctx.app.inject({ method: 'POST', url: '/businesses', headers: owner.auth, payload: { legalName: 'Acme Logistics' } })).json();

    const supPhone = fakePhone();
    const add = await ctx.app.inject({ method: 'POST', url: `/businesses/${biz.id}/members`, headers: owner.auth, payload: { phone: supPhone, role: 'supervisor' } });
    expect(add.statusCode).toBe(201);
    const sup = await signUp(ctx, 'business', supPhone); // invited user logs in with OTP

    expect((await ctx.app.inject({ method: 'GET', url: `/businesses/${biz.id}`, headers: sup.auth })).statusCode).toBe(200);

    // Supervisor can't manage members.
    const supAdd = await ctx.app.inject({ method: 'POST', url: `/businesses/${biz.id}/members`, headers: sup.auth, payload: { phone: fakePhone(), role: 'manager' } });
    expect(supAdd.statusCode).toBe(403);

    expect((await ctx.app.inject({ method: 'DELETE', url: `/businesses/${biz.id}/members/${add.json().id}`, headers: owner.auth })).statusCode).toBe(200);

    // Same, still-valid session token: access is gone on the very next request.
    expect((await ctx.app.inject({ method: 'GET', url: `/businesses/${biz.id}`, headers: sup.auth })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'GET', url: `/businesses/${biz.id}/members`, headers: sup.auth })).statusCode).toBe(404);
  });

  it('a worker number cannot be added as a business member', async () => {
    const owner = await signUp(ctx, 'business');
    const worker = await signUp(ctx, 'worker');
    const biz = (await ctx.app.inject({ method: 'POST', url: '/businesses', headers: owner.auth, payload: { legalName: 'Shop' } })).json();
    const r = await ctx.app.inject({ method: 'POST', url: `/businesses/${biz.id}/members`, headers: owner.auth, payload: { phone: worker.phone, role: 'supervisor' } });
    expect(r.statusCode).toBe(409);
  });

  it('the owner cannot remove themselves (business never becomes ownerless)', async () => {
    const owner = await signUp(ctx, 'business');
    const biz = (await ctx.app.inject({ method: 'POST', url: '/businesses', headers: owner.auth, payload: { legalName: 'Solo' } })).json();
    const members = (await ctx.app.inject({ method: 'GET', url: `/businesses/${biz.id}/members`, headers: owner.auth })).json();
    const r = await ctx.app.inject({ method: 'DELETE', url: `/businesses/${biz.id}/members/${members[0].id}`, headers: owner.auth });
    expect(r.statusCode).toBe(400);
  });
});
