import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { LANGS, USER_KINDS, normalizeIndianPhone } from '@shiftkart/shared';
import type { AppDeps } from '../app';
import { parse } from '../lib/validate';
import { badRequest } from '../lib/errors';
import { requestOtp, verifyOtp } from '../auth/otp';
import { refreshSession, revokeFamily } from '../auth/sessions';
import { userActor } from '../auth/guard';

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
  signup: z.object({
    kind: z.enum(USER_KINDS),
    lang: z.enum(LANGS),
    consents: z.array(z.enum(['account', 'location_at_shift', 'face_verification', 'notifications'])).max(10),
  }).strict().optional(),
}).strict();
const Refresh = z.object({ refreshToken: z.string().min(10).max(200) }).strict();

export async function authRoutes(app: FastifyInstance, { db, sms, config }: AppDeps) {
  const keys = { dataKey: config.dataKey, hashKey: config.hashKey };

  app.post('/auth/otp/request', { config: { auth: { public: true } } }, async (req) => {
    const { phone } = parse(OtpRequest, req.body);
    return requestOtp(db, sms, keys, phone, req.ip, config.otpGlobalHourly);
  });

  app.post('/auth/otp/verify', { config: { auth: { public: true } } }, async (req) => {
    const body = parse(OtpVerify, req.body);
    return verifyOtp(db, keys, body, req.ip);
  });

  app.post('/auth/refresh', { config: { auth: { public: true } } }, async (req) => {
    const { refreshToken } = parse(Refresh, req.body);
    if (!refreshToken.startsWith('sk_rt_')) throw badRequest('invalid_token', 'Invalid token.');
    return refreshSession(db, refreshToken, req.ip);
  });

  app.post('/auth/logout', { config: { auth: { user: {} } } }, async (req) => {
    const actor = userActor(req);
    await revokeFamily(db, actor.familyId, 'logout');
    return { ok: true };
  });
}
