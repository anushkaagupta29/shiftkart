// ACC-02: OTP brute force, OTP bombing, SMS pumping.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, fakeIp, fakePhone, latestCode, makeApp, resetData, type Ctx } from '../helpers';

let ctx: Ctx;
beforeAll(async () => { ctx = await makeApp(); await resetData(ctx.db); });
afterAll(async () => closeApp(ctx));

const request = (phone: string, ip = fakeIp()) =>
  ctx.app.inject({ method: 'POST', url: '/auth/otp/request', payload: { phone }, remoteAddress: ip });
const verify = (phone: string, code: string, ip = fakeIp()) =>
  ctx.app.inject({ method: 'POST', url: '/auth/otp/verify', remoteAddress: ip, payload: { phone, code, deviceId: 'device-12345678', signup: { kind: 'worker', lang: 'en', consents: ['account'] } } });

describe('ACC-02 OTP abuse', () => {
  it('locks the code after 5 wrong attempts; even the right code then fails', async () => {
    const phone = fakePhone();
    await request(phone);
    const code = await latestCode(ctx, phone);
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 1; i <= 4; i++) expect((await verify(phone, wrong)).json().error.code).toBe('invalid_code');
    expect((await verify(phone, wrong)).statusCode).toBe(429);
    const right = await verify(phone, code);
    expect(right.statusCode).toBe(429);
    expect(right.json().error.code).toBe('otp_locked');
  });

  it('allows 3 sends per phone per 15 minutes', async () => {
    const phone = fakePhone();
    for (let i = 0; i < 3; i++) expect((await request(phone)).statusCode).toBe(200);
    const fourth = await request(phone);
    expect(fourth.statusCode).toBe(429);
    expect(fourth.headers['retry-after']).toBeDefined();
  });

  it('limits sends per IP per hour (10), across different phones', async () => {
    const ip = fakeIp();
    for (let i = 0; i < 10; i++) expect((await request(fakePhone(), ip)).statusCode).toBe(200);
    expect((await request(fakePhone(), ip)).statusCode).toBe(429);
  });

  it('rejects non-Indian numbers (stops international SMS pumping)', async () => {
    for (const phone of ['+14155550100', '+447946000000', '+8613800138000']) {
      const r = await request(phone);
      expect(r.statusCode).toBe(400);
    }
    const sent = await ctx.db.query(`SELECT count(*)::int AS n FROM dev_outbox WHERE to_masked NOT LIKE '+91%'`);
    expect(sent.rows[0].n).toBe(0);
  });

  it('enforces a global hourly SMS budget', async () => {
    const small = await makeApp({ otpGlobalHourly: 1 });
    try {
      await resetData(small.db);
      expect((await small.app.inject({ method: 'POST', url: '/auth/otp/request', payload: { phone: fakePhone() }, remoteAddress: fakeIp() })).statusCode).toBe(200);
      const r = await small.app.inject({ method: 'POST', url: '/auth/otp/request', payload: { phone: fakePhone() }, remoteAddress: fakeIp() });
      expect(r.statusCode).toBe(503);
    } finally {
      await closeApp(small);
    }
  });

  it('rejects expired codes', async () => {
    const phone = fakePhone();
    await request(phone);
    const code = await latestCode(ctx, phone);
    await ctx.db.query(`UPDATE otp_requests SET expires_at = now() - interval '1 second'`);
    expect((await verify(phone, code)).json().error.code).toBe('invalid_code');
  });

  it('a code works once, even under parallel use', async () => {
    const phone = fakePhone();
    await request(phone);
    const code = await latestCode(ctx, phone);
    const results = await Promise.all(Array.from({ length: 5 }, () => verify(phone, code)));
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect((await verify(phone, code)).statusCode).not.toBe(200);
    const users = await ctx.db.query('SELECT count(*)::int AS n FROM users');
    const sessions = await ctx.db.query('SELECT count(*)::int AS n FROM sessions');
    expect(sessions.rows[0].n).toBe(1);
    expect(users.rows[0].n).toBe(1);
  });
});
