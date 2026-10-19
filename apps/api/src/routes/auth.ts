import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { LANGS, USER_KINDS, normalizeIndianPhone } from '@shiftkart/shared';
import type { AppDeps } from '../app';
import { parse } from '../lib/validate';
import { badRequest } from '../lib/errors';
import { requestOtp, verifyOtp } from '../auth/otp';
import { refreshSession, revokeFamily } from '../auth/sessions';
import { USER_COOKIE, USER_REFRESH_COOKIE, userActor } from '../auth/guard';
import { ACCESS_TTL_SEC, REFRESH_TTL_SEC, type TokenPair } from '../auth/sessions';
import type { FastifyReply } from 'fastify';

const phoneField = z.string().max(20).transform((p, ctx) => {
  const n = normalizeIndianPhone(p);
  if (!n) {
    ctx.addIssue({ code: 'custom', message: 'Enter a valid Indian mobile number (+91).' });
    return z.NEVER;
  }
  return n;
});

const OtpRequest = z.object({ phone: phoneField }).strict();
const OtpVerify = z.object({
  phone: phoneField,
  code: z.string().regex(/^\d{6}$/),
  deviceId: z.string().min(8).max(128),
  platform: z.enum(['android', 'ios', 'web', 'unknown']).default('unknown'),
  // 'web' = tokens go in HttpOnly cookies instead of the response body (browser apps).
  client: z.enum(['app', 'web']).default('app'),
  signup: z.object({
    kind: z.enum(USER_KINDS),
    lang: z.enum(LANGS),
    consents: z.array(z.enum(['account', 'location_at_shift', 'face_verification', 'notifications'])).max(10),
  }).strict().optional(),
}).strict();
const Refresh = z.object({ refreshToken: z.string().min(10).max(200).optional() }).strict();

export async function authRoutes(app: FastifyInstance, { db, sms, config }: AppDeps) {
  const keys = { dataKey: config.dataKey, hashKey: config.hashKey };
  const secure = config.env === 'production';
  const setWebCookies = (reply: FastifyReply, t: TokenPair) => {
    reply.setCookie(USER_COOKIE, t.accessToken, { httpOnly: true, sameSite: 'strict', secure, path: '/', maxAge: ACCESS_TTL_SEC });
    reply.setCookie(USER_REFRESH_COOKIE, t.refreshToken, { httpOnly: true, sameSite: 'strict', secure, path: '/auth', maxAge: REFRESH_TTL_SEC });
    return { accessExpiresAt: t.accessExpiresAt };
  };

  app.post('/auth/otp/request', { config: { auth: { public: true } } }, async (req) => {
    const { phone } = parse(OtpRequest, req.body);
    return requestOtp(db, sms, keys, phone, req.ip, config.otpGlobalHourly);
  });

  app.post('/auth/otp/verify', { config: { auth: { public: true } } }, async (req, reply) => {
    const { client, ...body } = parse(OtpVerify, req.body);
    const r = await verifyOtp(db, keys, body, req.ip);
    if (client === 'web') return { user: r.user, ...setWebCookies(reply, r) };
    return r;
  });

  app.post('/auth/refresh', { config: { auth: { public: true } } }, async (req, reply) => {
    const body = parse(Refresh, req.body);
    const fromCookie = !body.refreshToken;
    const refreshToken = body.refreshToken ?? req.cookies?.[USER_REFRESH_COOKIE];
    if (!refreshToken?.startsWith('sk_rt_')) throw badRequest('invalid_token', 'Invalid token.');
    const t = await refreshSession(db, refreshToken, req.ip);
    return fromCookie ? setWebCookies(reply, t) : t;
  });

  app.post('/auth/logout', { config: { auth: { user: {} } } }, async (req, reply) => {
    const actor = userActor(req);
    await revokeFamily(db, actor.familyId, 'logout');
    reply.clearCookie(USER_COOKIE, { path: '/' }).clearCookie(USER_REFRESH_COOKIE, { path: '/auth' });
    return { ok: true };
  });
}
