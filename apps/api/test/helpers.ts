import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { encrypt, hashPassword, newTotpSecret, totp, type StaffRole } from '@shiftkart/shared';
import { requireEnv } from '@shiftkart/db';
import { buildApp } from '../src/app';
import { loadConfig, type Config } from '../src/config';
import { createPool, type Db } from '../src/db';

export type Ctx = { app: FastifyInstance; db: Db; config: Config };

export async function makeApp(overrides: Partial<Config> = {}, logStream?: NodeJS.WritableStream): Promise<Ctx> {
  const config = loadConfig({
    env: 'test',
    databaseUrl: requireEnv('DATABASE_URL_TEST'),
    devEndpoints: true,
    rateLimitPerMin: 100_000,
    logLevel: logStream ? 'info' : 'silent',
    ...overrides,
  });
  const db = createPool(config.databaseUrl);
  const app = await buildApp(config, db, { logStream });
  await app.ready();
  return { app, db, config };
}

export async function closeApp(ctx: Ctx) {
  await ctx.app.close();
  await ctx.db.end();
}

const KEEP = new Set(['schema_migrations', 'cities', 'skills', 'role_categories', 'spatial_ref_sys']);
export async function resetData(db: Db) {
  const t = await db.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`);
  const tables = t.rows.map((r) => r.tablename as string).filter((n) => !KEEP.has(n));
  await db.query(`TRUNCATE ${tables.join(', ')} RESTART IDENTITY CASCADE`);
}

let counter = 0;
/** Unique fake Indian mobile per call. */
export function fakePhone(): string {
  counter += 1;
  return `+9197${String(process.pid % 1000).padStart(3, '0')}${String(counter).padStart(5, '0')}`;
}

/** Fresh IP per call so the per-IP OTP limit only applies where a test wants it. */
export function fakeIp(): string {
  counter += 1;
  return `10.${(counter >> 16) & 255}.${(counter >> 8) & 255}.${counter & 255}`;
}

export async function latestCode(ctx: Ctx, phone: string): Promise<string> {
  const res = await ctx.app.inject({ method: 'POST', url: '/dev/outbox', payload: { phone } });
  const body = res.json()[0]?.body as string | undefined;
  const code = body?.match(/\b(\d{6})\b/)?.[1];
  if (!code) throw new Error(`no OTP found for ${phone}`);
  return code;
}

export type LoggedIn = { userId: string; accessToken: string; refreshToken: string; phone: string; auth: { authorization: string } };

export async function signUp(ctx: Ctx, kind: 'worker' | 'business', phone = fakePhone(), ip = fakeIp()): Promise<LoggedIn> {
  const r1 = await ctx.app.inject({ method: 'POST', url: '/auth/otp/request', payload: { phone }, remoteAddress: ip });
  if (r1.statusCode !== 200) throw new Error(`otp request failed ${r1.statusCode} ${r1.body}`);
  const code = await latestCode(ctx, phone);
  const r2 = await ctx.app.inject({
    method: 'POST', url: '/auth/otp/verify', remoteAddress: ip,
    payload: { phone, code, deviceId: `device-${randomUUID()}`, platform: 'android', signup: { kind, lang: 'hi', consents: ['account'] } },
  });
  if (r2.statusCode !== 200) throw new Error(`verify failed ${r2.statusCode} ${r2.body}`);
  const b = r2.json();
  return { userId: b.user.id, accessToken: b.accessToken, refreshToken: b.refreshToken, phone, auth: { authorization: `Bearer ${b.accessToken}` } };
}

export const TEST_STAFF_PASSWORD = 'test-only-password-1';

export type StaffLogin = { staffId: string; email: string; cookie: { cookie: string }; secret: string };

/** Creates a staff user directly in the DB, then logs in through the real endpoint. */
export async function staffWith(ctx: Ctx, roles: StaffRole[]): Promise<StaffLogin> {
  const email = `${roles.join('-')}-${randomBytes(4).toString('hex')}@test.local`;
  const secret = newTotpSecret();
  const r = await ctx.db.query(
    `INSERT INTO staff_users (email, name, password_hash, totp_secret_enc, roles) VALUES ($1, 'Test', $2, $3, $4) RETURNING id`,
    [email, await hashPassword(TEST_STAFF_PASSWORD), encrypt(secret, ctx.config.dataKey), roles],
  );
  const res = await ctx.app.inject({
    method: 'POST', url: '/admin/auth/login',
    payload: { email, password: TEST_STAFF_PASSWORD, totp: totp(secret) },
  });
  if (res.statusCode !== 200) throw new Error(`staff login failed ${res.statusCode} ${res.body}`);
  const token = res.cookies.find((c) => c.name === 'sk_staff')!.value;
  return { staffId: r.rows[0].id, email, secret, cookie: { cookie: `sk_staff=${token}` } };
}
