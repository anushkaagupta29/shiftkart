// MSG-06: personal data and secrets never reach the logs.
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, fakeIp, fakePhone, latestCode, makeApp, resetData, type Ctx } from '../helpers';

let ctx: Ctx;
const lines: string[] = [];
beforeAll(async () => {
  const stream = new Writable({ write(chunk, _enc, cb) { lines.push(chunk.toString()); cb(); } });
  ctx = await makeApp({}, stream);
  await resetData(ctx.db);
});
afterAll(async () => closeApp(ctx));

describe('MSG-06 log redaction', () => {
  it('OTP flows log no phone numbers, codes or tokens', async () => {
    const phone = fakePhone();
    const ip = fakeIp();
    await ctx.app.inject({ method: 'POST', url: '/auth/otp/request', payload: { phone }, remoteAddress: ip });
    const code = await latestCode(ctx, phone);
    const v = await ctx.app.inject({
      method: 'POST', url: '/auth/otp/verify', remoteAddress: ip,
      payload: { phone, code, deviceId: 'device-abcdefgh', signup: { kind: 'worker', lang: 'en', consents: ['account'] } },
    });
    const { accessToken } = v.json();
    await ctx.app.inject({ method: 'GET', url: '/me', headers: { authorization: `Bearer ${accessToken}` } });

    const all = lines.join('\n');
    expect(lines.length).toBeGreaterThan(0);
    expect(all).not.toContain(phone.slice(3));
    expect(all).not.toContain(code);
    expect(all).not.toContain(accessToken);
  });

  it('free-text log messages are scrubbed', async () => {
    ctx.app.log.info('worker 98765 43210 wrote to test@example.com');
    ctx.app.log.error(new Error('failed for +919876543210'));
    const all = lines.join('\n');
    expect(all).not.toMatch(/98765\s?43210/);
    expect(all).not.toContain('test@example.com');
  });
});
