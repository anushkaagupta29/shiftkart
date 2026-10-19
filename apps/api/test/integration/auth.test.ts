import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, fakeIp, fakePhone, latestCode, makeApp, resetData, signUp, type Ctx } from '../helpers';

let ctx: Ctx;
beforeAll(async () => { ctx = await makeApp(); await resetData(ctx.db); });
afterAll(async () => closeApp(ctx));

describe('worker/business OTP login', () => {
  it('signs up a new worker, then logs in again as the same account', async () => {
    const w = await signUp(ctx, 'worker');
    const me = await ctx.app.inject({ method: 'GET', url: '/me', headers: w.auth });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toMatchObject({ kind: 'worker', preferredLang: 'hi' });
    expect(me.json().phone).toMatch(/^\+91 \*{6}\d{4}$/);

    const ip = fakeIp();
    await ctx.app.inject({ method: 'POST', url: '/auth/otp/request', payload: { phone: w.phone }, remoteAddress: ip });
    const code = await latestCode(ctx, w.phone);
    const again = await ctx.app.inject({ method: 'POST', url: '/auth/otp/verify', remoteAddress: ip, payload: { phone: w.phone, code, deviceId: 'device-second-phone' } });
    expect(again.statusCode).toBe(200);
    expect(again.json().user).toMatchObject({ id: w.userId, isNew: false });
  });

  it('stores the phone encrypted, never in plain text', async () => {
    const w = await signUp(ctx, 'worker');
    const row = (await ctx.db.query('SELECT * FROM users WHERE id = $1', [w.userId])).rows[0];
    expect(JSON.stringify(row)).not.toContain(w.phone.slice(3));
  });

  it('asks a new number to choose worker/business without burning the code', async () => {
    const phone = fakePhone();
    const ip = fakeIp();
    await ctx.app.inject({ method: 'POST', url: '/auth/otp/request', payload: { phone }, remoteAddress: ip });
    const code = await latestCode(ctx, phone);
    const r1 = await ctx.app.inject({ method: 'POST', url: '/auth/otp/verify', remoteAddress: ip, payload: { phone, code, deviceId: 'device-abcdefgh' } });
    expect(r1.statusCode).toBe(409);
    expect(r1.json().error.code).toBe('signup_required');
    const r2 = await ctx.app.inject({
      method: 'POST', url: '/auth/otp/verify', remoteAddress: ip,
      payload: { phone, code, deviceId: 'device-abcdefgh', signup: { kind: 'business', lang: 'en', consents: [] } },
    });
    expect(r2.json().error.code).toBe('consent_required');
    const r3 = await ctx.app.inject({
      method: 'POST', url: '/auth/otp/verify', remoteAddress: ip,
      payload: { phone, code, deviceId: 'device-abcdefgh', signup: { kind: 'business', lang: 'en', consents: ['account'] } },
    });
    expect(r3.statusCode).toBe(200);
    const consents = await ctx.db.query('SELECT purpose FROM consents WHERE user_id = $1', [r3.json().user.id]);
    expect(consents.rows.map((c) => c.purpose)).toEqual(['account']);
  });

  it('refresh rotates tokens and logout ends the session', async () => {
    const w = await signUp(ctx, 'worker');
    const r = await ctx.app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken: w.refreshToken } });
    expect(r.statusCode).toBe(200);
    const fresh = r.json();
    expect(fresh.accessToken).not.toBe(w.accessToken);
    const auth = { authorization: `Bearer ${fresh.accessToken}` };
    expect((await ctx.app.inject({ method: 'GET', url: '/me', headers: auth })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'POST', url: '/auth/logout', headers: auth })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: '/me', headers: auth })).statusCode).toBe(401);
  });

  it('lists and signs out other devices', async () => {
    const w = await signUp(ctx, 'worker');
    const list = await ctx.app.inject({ method: 'GET', url: '/me/sessions', headers: w.auth });
    expect(list.json()).toHaveLength(1);
    expect(list.json()[0].current).toBe(true);
    const del = await ctx.app.inject({ method: 'DELETE', url: `/me/sessions/${list.json()[0].id}`, headers: w.auth });
    expect(del.statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: '/me', headers: w.auth })).statusCode).toBe(401);
  });

  it('suspended users are locked out at once', async () => {
    const w = await signUp(ctx, 'worker');
    await ctx.db.query(`UPDATE users SET status = 'suspended' WHERE id = $1`, [w.userId]);
    expect((await ctx.app.inject({ method: 'GET', url: '/me', headers: w.auth })).statusCode).toBe(401);
  });
});
