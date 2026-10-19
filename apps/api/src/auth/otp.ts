import { randomInt, randomUUID } from 'node:crypto';
import { encrypt, lookupHash, maskPhone, safeEqual, type Lang, type UserKind } from '@shiftkart/shared';
import type { Db } from '../db';
import { withTx } from '../db';
import type { SmsSender } from '../adapters/sms';
import { getPolicy } from '../policy';
import { HttpError, badRequest, conflict, tooMany } from '../lib/errors';
import { createSession, type TokenPair } from './sessions';
import { writeAudit } from '../audit';

export const CONSENT_VERSION = 'draft-0'; // placeholder until the lawyer-approved notice exists (L-18)

type Keys = { dataKey: string; hashKey: string };

/**
 * ACC-02: per-phone and per-IP limits are counted in Postgres (durable across restarts and
 * API instances), plus a global hourly budget to stop SMS-pumping fraud.
 */
export async function requestOtp(db: Db, sms: SmsSender, keys: Keys, phone: string, ip: string, globalHourly: number) {
  const phoneHash = lookupHash(phone, keys.hashKey);
  const ttl = await getPolicy<number>(db, 'otp.ttl_sec');
  const perPhone = await getPolicy<number>(db, 'otp.per_phone_15min');
  const perIp = await getPolicy<number>(db, 'otp.per_ip_hour');

  const code = randomInt(0, 1_000_000).toString().padStart(6, '0');
  await withTx(db, async (tx) => {
    // Serialise requests for the same phone so two parallel requests can't both slip under the limit.
    await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [phoneHash]);
    const c = await tx.query(
      `SELECT count(*) FILTER (WHERE phone_hash = $1 AND created_at > now() - interval '15 minutes') AS per_phone,
              count(*) FILTER (WHERE ip = $2) AS per_ip,
              count(*) AS global
         FROM otp_requests WHERE created_at > now() - interval '1 hour'`,
      [phoneHash, ip],
    );
    const counts = c.rows[0];
    if (counts.per_phone >= perPhone) throw tooMany('otp_rate_limited', 'Too many codes requested. Please wait 15 minutes.', 900);
    if (counts.per_ip >= perIp) throw tooMany('otp_rate_limited', 'Too many codes requested from this network. Try later.', 3600);
    if (counts.global >= globalHourly) throw new HttpError(503, 'otp_unavailable', 'Login codes are temporarily unavailable.');

    const id = randomUUID();
    await tx.query(
      `INSERT INTO otp_requests (id, phone_hash, code_hash, ip, expires_at) VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5))`,
      [id, phoneHash, lookupHash(`${id}:${code}`, keys.hashKey), ip, ttl],
    );
    await sms.send(phone, `ShiftKart code: ${code}. Valid ${Math.round(ttl / 60)} min. Never share it. ShiftKart never asks you for money.`);
  });
  return { expiresInSec: ttl, sentTo: maskPhone(phone) };
}

export type SignupInfo = { kind: UserKind; lang: Lang; consents: string[] };

export type VerifyResult = TokenPair & {
  user: { id: string; kind: UserKind; status: string; preferredLang: string; phone: string; isNew: boolean };
};

export async function verifyOtp(
  db: Db, keys: Keys,
  input: { phone: string; code: string; deviceId: string; platform: string; signup?: SignupInfo },
  ip: string,
): Promise<VerifyResult> {
  const phoneHash = lookupHash(input.phone, keys.hashKey);
  const maxAttempts = await getPolicy<number>(db, 'otp.max_attempts');

  // Wrong attempts must be counted even though the request fails, so the transaction returns
  // an error value instead of throwing (which would roll the counter back).
  const result = await withTx(db, async (tx): Promise<VerifyResult | HttpError> => {
    const r = await tx.query(
      `SELECT * FROM otp_requests WHERE phone_hash = $1 AND consumed_at IS NULL
        ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
      [phoneHash],
    );
    const otp = r.rows[0];
    const invalid = badRequest('invalid_code', 'That code is wrong or expired. Request a new one.');
    if (!otp || otp.expires_at <= new Date()) return invalid;
    if (otp.locked_at || otp.attempts >= maxAttempts) {
      return tooMany('otp_locked', 'Too many wrong codes. Request a new code.', 60);
    }
    if (!safeEqual(lookupHash(`${otp.id}:${input.code}`, keys.hashKey), otp.code_hash)) {
      const u = await tx.query(
        `UPDATE otp_requests SET attempts = attempts + 1,
                locked_at = CASE WHEN attempts + 1 >= $2 THEN now() ELSE NULL END
          WHERE id = $1 RETURNING attempts`,
        [otp.id, maxAttempts],
      );
      return u.rows[0].attempts >= maxAttempts
        ? tooMany('otp_locked', 'Too many wrong codes. Request a new code.', 60)
        : invalid;
    }

    let user = (await tx.query('SELECT * FROM users WHERE phone_hash = $1', [phoneHash])).rows[0];
    let isNew = false;
    if (!user) {
      // Don't burn the code: the app asks "worker or business?" and retries with the same code.
      if (!input.signup) return conflict('signup_required', 'New number. Choose worker or business to sign up.');
      if (!input.signup.consents.includes('account')) {
        return badRequest('consent_required', 'Please accept the account consent to continue.');
      }
      user = (await tx.query(
        `INSERT INTO users (phone_enc, phone_hash, phone_last4, kind, preferred_lang) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [encrypt(input.phone, keys.dataKey), phoneHash, input.phone.slice(-4), input.signup.kind, input.signup.lang],
      )).rows[0];
      for (const purpose of new Set(input.signup.consents)) {
        await tx.query('INSERT INTO consents (user_id, purpose, version, lang) VALUES ($1, $2, $3, $4)',
          [user.id, purpose, CONSENT_VERSION, input.signup.lang]);
      }
      await writeAudit(tx, { actorType: 'user', actorId: user.id, action: 'user.signup', targetType: 'user', targetId: user.id, after: { kind: user.kind }, ip });
      isNew = true;
    }

    const consumed = await tx.query('UPDATE otp_requests SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL', [otp.id]);
    if (consumed.rowCount !== 1) return invalid; // used by a parallel request

    if (user.status === 'suspended' || user.status === 'deleted') {
      return new HttpError(403, 'account_suspended', 'This account is suspended. Contact support.');
    }

    const device = await tx.query(
      `INSERT INTO devices (user_id, device_id_hash, platform) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, device_id_hash) DO UPDATE SET last_seen = now() RETURNING id`,
      [user.id, lookupHash(input.deviceId, keys.hashKey), input.platform],
    );
    await tx.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
    const tokens = await createSession(tx, user.id, device.rows[0].id);
    return {
      ...tokens,
      user: { id: user.id, kind: user.kind, status: user.status, preferredLang: user.preferred_lang, phone: maskPhone(input.phone), isNew },
    };
  });
  if (result instanceof HttpError) throw result;
  return result;
}
