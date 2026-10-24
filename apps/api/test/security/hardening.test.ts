import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totp } from '@shiftkart/shared';
import { requireEnv } from '@shiftkart/db';
import { closeApp, fakePhone, makeApp, resetData, staffWith, type Ctx } from '../helpers';
import { loadConfig, productionProblems } from '../../src/config';

let ctx: Ctx;
beforeAll(async () => { ctx = await makeApp(); await resetData(ctx.db); });
afterAll(async () => closeApp(ctx));

describe('least-privilege database role (INT-01 second wall)', () => {
  it('the app role can write rows but cannot edit history, truncate, or switch off triggers', async () => {
    await ctx.db.query(`ALTER ROLE shiftkart_app PASSWORD 'local-test-only'`);
    const url = new URL(requireEnv('DATABASE_URL_TEST'));
    url.username = 'shiftkart_app';
    url.password = 'local-test-only';
    const app = new pg.Client({ connectionString: url.toString() });
    await app.connect();
    try {
      await app.query(`INSERT INTO dev_outbox (channel, to_hash, to_masked, body) VALUES ('sms', 'h', 'm', 'b')`);
      await expect(app.query(`UPDATE audit_log SET reason = 'x'`)).rejects.toThrow(/permission denied/);
      await expect(app.query(`DELETE FROM ledger_entries`)).rejects.toThrow(/permission denied/);
      await expect(app.query(`DELETE FROM payslips`)).rejects.toThrow(/permission denied/);
      await expect(app.query(`TRUNCATE users CASCADE`)).rejects.toThrow(/permission denied|must be owner/);
      await expect(app.query(`ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only`)).rejects.toThrow(/must be owner/);
      await expect(app.query(`DROP TABLE audit_log`)).rejects.toThrow(/must be owner/);
    } finally {
      await app.end();
    }
  });
});

describe('production safety checks', () => {
  it('lists unsafe production settings', () => {
    const cfg = loadConfig({ env: 'test' });
    const problems = productionProblems({ ...cfg, env: 'production', publicApiUrl: 'http://x', trustProxy: false, rateLimitPerMin: 100000 });
    expect(problems.join(' ')).toMatch(/https/);
    expect(problems.join(' ')).toMatch(/TRUST_PROXY/);
    expect(problems.join(' ')).toMatch(/local database/);
    expect(problems.join(' ')).toMatch(/RATE_LIMIT_PER_MIN/);
  });

  it('refuses to start in production with them', () => {
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try { expect(() => loadConfig()).toThrow(/Refusing to start in production/); } finally { process.env.NODE_ENV = before; }
  });
});

describe('spoofed client addresses', () => {
  it('without a trusted proxy, X-Forwarded-For is ignored, so per-IP OTP limits still bite', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 11; i++) {
      codes.push((await ctx.app.inject({ method: 'POST', url: '/auth/otp/request', payload: { phone: fakePhone() }, remoteAddress: '10.77.0.1', headers: { 'x-forwarded-for': `1.2.3.${i}` } })).statusCode);
    }
    expect(codes.at(-1)).toBe(429);
  });

  it('behind one trusted proxy, the client address from the proxy is used', async () => {
    const proxied = await makeApp({ trustProxy: 1 });
    try {
      const codes: number[] = [];
      for (let i = 0; i < 11; i++) {
        codes.push((await proxied.app.inject({ method: 'POST', url: '/auth/otp/request', payload: { phone: fakePhone() }, remoteAddress: '10.0.0.254', headers: { 'x-forwarded-for': `1.2.4.${i}` } })).statusCode);
      }
      expect(codes.every((c) => c === 200)).toBe(true); // 11 different real clients behind one load balancer
    } finally {
      await closeApp(proxied);
    }
  });
});

describe('new staff passwords', () => {
  it('a new staff member must replace the one-time password; weak passwords are refused; other sessions end', async () => {
    const sa = await staffWith(ctx, ['super_admin']);
    const created = (await ctx.app.inject({ method: 'POST', url: '/admin/staff', headers: sa.cookie, payload: { email: 'newbie@test.local', name: 'New Person', roles: ['ops_support'], reason: 'Hired for support desk' } })).json();
    const login = await ctx.app.inject({ method: 'POST', url: '/admin/auth/login', payload: { email: 'newbie@test.local', password: created.tempPassword, totp: totp(created.totpSecret) } });
    expect(login.json().staff.mustChangePassword).toBe(true);
    const cookie = { cookie: `sk_staff=${login.cookies.find((c) => c.name === 'sk_staff')!.value}` };
    expect((await ctx.app.inject({ method: 'POST', url: '/admin/me/password', headers: cookie, payload: { current: created.tempPassword, next: 'short1' } })).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: 'POST', url: '/admin/me/password', headers: cookie, payload: { current: created.tempPassword, next: 'a-much-longer-passphrase-2026' } })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: '/admin/me', headers: cookie })).json().mustChangePassword).toBe(false);
  });
});

describe('payout emergency stop (BREACH_RESPONSE.md)', () => {
  it('while payouts.paused is on, approved pay waits in the queue; turning it off pays it', async () => {
    const { seedRates, verifiedBusiness, workedShift, runJobs } = await import('../fixtures');
    await seedRates(ctx);
    const b = await verifiedBusiness(ctx);
    const s = await workedShift(ctx, b);
    const setPaused = (v: boolean) => ctx.db.query(`INSERT INTO policy_config (key, value, reason, effective_from) VALUES ('payouts.paused', $1, 'test', now() - interval '1 second')`, [JSON.stringify(v)]);
    await setPaused(true);
    expect((await ctx.app.inject({ method: 'POST', url: `/businesses/${b.businessId}/timesheets/${s.timesheet.id}/approve`, headers: b.owner.auth })).statusCode).toBe(200);
    expect((await runJobs(ctx)).payoutsPaid).toBe(0);
    const status = async () => (await ctx.db.query(`SELECT status FROM payouts WHERE timesheet_id = $1`, [s.timesheet.id])).rows[0]?.status;
    expect(await status()).toBe('queued');
    await setPaused(false);
    await runJobs(ctx);
    expect(await status()).toBe('paid');
  });
});
