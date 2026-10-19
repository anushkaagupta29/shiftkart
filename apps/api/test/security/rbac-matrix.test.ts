// Every route × every role: auth is enforced in the API, not the UI.
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { STAFF_ROLES } from '@shiftkart/shared';
import { registerAuthGuard } from '../../src/auth/guard';
import { closeApp, makeApp, resetData, signUp, staffWith, type Ctx, type LoggedIn, type StaffLogin } from '../helpers';

let ctx: Ctx;
let staff: Record<string, StaffLogin>;
let worker: LoggedIn;
let business: LoggedIn;

beforeAll(async () => {
  ctx = await makeApp();
  await resetData(ctx.db);
  staff = {};
  for (const role of STAFF_ROLES) staff[role] = await staffWith(ctx, [role]);
  worker = await signUp(ctx, 'worker');
  business = await signUp(ctx, 'business');
});
afterAll(async () => closeApp(ctx));

const fill = (url: string) => url.replace(/:[A-Za-z]+/g, '00000000-0000-4000-8000-000000000000');

describe('route inventory', () => {
  it('a route without an auth rule makes startup fail (deny by default)', async () => {
    const app = Fastify();
    registerAuthGuard(app, ctx.db);
    expect(() => app.get('/oops', async () => 'open')).toThrow(/no auth rule/);
  });

  it('public routes are exactly the expected list', () => {
    const pub = ctx.app.authTable.filter((r) => 'public' in r.auth).map((r) => `${r.method} ${r.url}`).sort();
    expect(pub).toEqual([
      'GET /health',
      'POST /admin/auth/login',
      'POST /auth/otp/request',
      'POST /auth/otp/verify',
      'POST /auth/refresh',
      'POST /dev/outbox',
    ]);
  });

  it('every /admin route except login is staff-only', () => {
    const admin = ctx.app.authTable.filter((r) => r.url.startsWith('/admin') && r.url !== '/admin/auth/login');
    expect(admin.length).toBeGreaterThan(10);
    for (const r of admin) expect('staff' in r.auth, `${r.method} ${r.url}`).toBe(true);
  });
});

describe('staff routes', () => {
  it('reject anonymous, user tokens, and staff without the role', async () => {
    // Logout is covered in owasp.test.ts; here it would end the sessions the matrix relies on.
    const routes = ctx.app.authTable.filter((r) => 'staff' in r.auth && r.url !== '/admin/auth/logout');
    for (const r of routes) {
      const url = fill(r.url);
      const method = r.method as 'GET';
      const anon = await ctx.app.inject({ method, url, payload: method === 'GET' ? undefined : {} });
      expect(anon.statusCode, `anon ${r.method} ${r.url}`).toBe(401);
      const asWorker = await ctx.app.inject({ method, url, headers: worker.auth, payload: method === 'GET' ? undefined : {} });
      expect(asWorker.statusCode, `worker ${r.method} ${r.url}`).toBe(401);

      const allowed = (r.auth as { staff: string[] | 'any' }).staff;
      for (const role of STAFF_ROLES) {
        const res = await ctx.app.inject({ method, url, headers: staff[role]!.cookie, payload: method === 'GET' ? undefined : {} });
        const shouldPass = allowed === 'any' || allowed.includes(role);
        if (shouldPass) expect(res.statusCode, `${role} ${r.method} ${r.url}`).not.toBe(403);
        else expect(res.statusCode, `${role} ${r.method} ${r.url}`).toBe(403);
      }
    }
  });
});

describe('user routes', () => {
  it('reject anonymous and staff; business-only routes reject workers', async () => {
    const routes = ctx.app.authTable.filter((r) => 'user' in r.auth);
    for (const r of routes) {
      const url = fill(r.url);
      const method = r.method as 'GET';
      const payload = method === 'GET' || method === ('DELETE' as 'GET') ? undefined : {};
      expect((await ctx.app.inject({ method, url, payload })).statusCode, `anon ${r.method} ${r.url}`).toBe(401);
      expect((await ctx.app.inject({ method, url, headers: staff.super_admin!.cookie, payload })).statusCode).toBe(401);
      const kinds = (r.auth as { user: { kinds?: string[] } }).user.kinds;
      if (kinds && !kinds.includes('worker')) {
        expect((await ctx.app.inject({ method, url, headers: worker.auth, payload })).statusCode, `worker ${r.method} ${r.url}`).toBe(403);
      }
      if (kinds?.includes('business')) {
        expect((await ctx.app.inject({ method, url, headers: business.auth, payload })).statusCode).not.toBe(403);
      }
    }
  });
});
