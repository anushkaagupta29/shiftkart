// MSG-05: OWASP Top 10 basics — injection, broken access control, mass assignment,
// auth failures, security misconfiguration.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totp } from '@shiftkart/shared';
import { TEST_STAFF_PASSWORD, closeApp, makeApp, resetData, signUp, staffWith, type Ctx } from '../helpers';

let ctx: Ctx;
beforeAll(async () => { ctx = await makeApp(); await resetData(ctx.db); });
afterAll(async () => closeApp(ctx));

const SQLI = [`' OR '1'='1`, `'; DROP TABLE users; --`, `" OR 1=1 --`, `1); DELETE FROM sessions; --`];

describe('A03 injection', () => {
  it('SQL payloads are stored as plain text and never break queries', async () => {
    const owner = await signUp(ctx, 'business');
    for (const p of SQLI) {
      const r = await ctx.app.inject({ method: 'POST', url: '/businesses', headers: owner.auth, payload: { legalName: p } });
      expect(r.statusCode).toBe(201);
      expect(r.json().legalName).toBe(p);
    }
    const s = await staffWith(ctx, ['ops_support']);
    for (const p of SQLI) {
      const r = await ctx.app.inject({ method: 'POST', url: '/admin/users/search', headers: s.cookie, payload: { phone: p } });
      expect(r.statusCode).toBe(400);
      const q = await ctx.app.inject({ method: 'GET', url: `/admin/users?kind=${encodeURIComponent(p)}`, headers: s.cookie });
      expect(q.statusCode).toBe(400);
    }
    expect((await ctx.db.query('SELECT count(*)::int AS n FROM users')).rows[0].n).toBeGreaterThan(0);
  });

  it('script tags come back as JSON data, never HTML', async () => {
    const owner = await signUp(ctx, 'business');
    const r = await ctx.app.inject({ method: 'POST', url: '/businesses', headers: owner.auth, payload: { legalName: '<script>alert(1)</script>' } });
    expect(r.headers['content-type']).toMatch(/application\/json/);
  });
});

describe('A01/A04 mass assignment', () => {
  it('unknown fields are rejected, so kind/status/role cannot be set by the client', async () => {
    const w = await signUp(ctx, 'worker');
    const r = await ctx.app.inject({ method: 'PATCH', url: '/me', headers: w.auth, payload: { preferredLang: 'kn', kind: 'business', status: 'active' } });
    expect(r.statusCode).toBe(400);
    const me = (await ctx.app.inject({ method: 'GET', url: '/me', headers: w.auth })).json();
    expect(me.kind).toBe('worker');

    const owner = await signUp(ctx, 'business');
    const b = await ctx.app.inject({ method: 'POST', url: '/businesses', headers: owner.auth, payload: { legalName: 'X Ltd', verificationStatus: 'verified' } });
    expect(b.statusCode).toBe(400);

    const biz = (await ctx.app.inject({ method: 'POST', url: '/businesses', headers: owner.auth, payload: { legalName: 'Y Ltd' } })).json();
    const m = await ctx.app.inject({ method: 'POST', url: `/businesses/${biz.id}/members`, headers: owner.auth, payload: { phone: '9123456780', role: 'owner' } });
    expect(m.statusCode).toBe(400);
  });
});

describe('A07 authentication failures (staff)', () => {
  it('locks the account after 5 failures', async () => {
    const s = await staffWith(ctx, ['ops_support']);
    for (let i = 0; i < 5; i++) {
      const r = await ctx.app.inject({ method: 'POST', url: '/admin/auth/login', payload: { email: s.email, password: 'wrong-password', totp: '000000' } });
      expect(r.statusCode).toBe(401);
    }
    const locked = await ctx.app.inject({ method: 'POST', url: '/admin/auth/login', payload: { email: s.email, password: TEST_STAFF_PASSWORD, totp: totp(s.secret, Date.now() + 30_000) } });
    expect(locked.statusCode).toBe(429);
  });

  it('a 2FA code cannot be replayed', async () => {
    const s = await staffWith(ctx, ['ops_support']); // logged in with the current code
    const replay = await ctx.app.inject({ method: 'POST', url: '/admin/auth/login', payload: { email: s.email, password: TEST_STAFF_PASSWORD, totp: totp(s.secret) } });
    expect(replay.statusCode).toBe(401);
  });

  it('unknown email and wrong password give the same answer', async () => {
    const s = await staffWith(ctx, ['ops_support']);
    const a = await ctx.app.inject({ method: 'POST', url: '/admin/auth/login', payload: { email: 'nobody@test.local', password: 'x', totp: '123456' } });
    const b = await ctx.app.inject({ method: 'POST', url: '/admin/auth/login', payload: { email: s.email, password: 'x', totp: '123456' } });
    expect(a.statusCode).toBe(b.statusCode);
    expect(a.json()).toEqual(b.json());
  });

  it('staff session cookie is HttpOnly and SameSite=Strict', async () => {
    const s = await staffWith(ctx, ['ops_support']);
    const r = await ctx.app.inject({ method: 'POST', url: '/admin/auth/login', payload: { email: s.email, password: TEST_STAFF_PASSWORD, totp: totp(s.secret, Date.now() + 30_000) } });
    const c = r.cookies.find((x) => x.name === 'sk_staff')!;
    expect(c.httpOnly).toBe(true);
    expect(c.sameSite).toBe('Strict');
  });

  it('logout revokes the staff session server-side', async () => {
    const s = await staffWith(ctx, ['ops_support']);
    await ctx.app.inject({ method: 'POST', url: '/admin/auth/logout', headers: s.cookie });
    expect((await ctx.app.inject({ method: 'GET', url: '/admin/me', headers: s.cookie })).statusCode).toBe(401);
  });
});

describe('A05 security misconfiguration', () => {
  it('sends security headers', async () => {
    const r = await ctx.app.inject({ method: 'GET', url: '/health' });
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['strict-transport-security']).toBeDefined();
    expect(r.headers['content-security-policy']).toBeDefined();
    expect(r.headers['x-powered-by']).toBeUndefined();
  });

  it('CORS only allows our own front-ends', async () => {
    const evil = await ctx.app.inject({ method: 'GET', url: '/health', headers: { origin: 'https://evil.example' } });
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
    const ours = await ctx.app.inject({ method: 'GET', url: '/health', headers: { origin: 'http://localhost:3001' } });
    expect(ours.headers['access-control-allow-origin']).toBe('http://localhost:3001');
  });

  it('answers CORS preflights from the admin console', async () => {
    const r = await ctx.app.inject({
      method: 'OPTIONS', url: '/admin/users/search',
      headers: { origin: 'http://localhost:3001', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
    });
    expect(r.statusCode).toBe(204);
    expect(r.headers['access-control-allow-origin']).toBe('http://localhost:3001');
    expect(r.headers['access-control-allow-credentials']).toBe('true');
  });

  it('rejects oversized and non-JSON bodies without leaking internals', async () => {
    const big = await ctx.app.inject({ method: 'POST', url: '/auth/otp/request', payload: { phone: 'x'.repeat(200_000) } });
    expect(big.statusCode).toBe(413);
    const form = await ctx.app.inject({ method: 'POST', url: '/auth/otp/request', payload: 'phone=9876543210', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(form.statusCode).toBe(415);
    const bad = await ctx.app.inject({ method: 'POST', url: '/auth/otp/request', payload: '{bad json', headers: { 'content-type': 'application/json' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).not.toMatch(/stack|at .*\.ts/);
  });

  it('dev endpoints are not registered in production', async () => {
    const prod = await makeApp({ env: 'production', devEndpoints: true });
    try {
      expect(prod.app.authTable.some((r) => r.url.startsWith('/dev'))).toBe(false);
    } finally {
      await closeApp(prod);
    }
  });
});
