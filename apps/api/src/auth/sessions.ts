import { randomToken, sha256 } from '@shiftkart/shared';
import { randomUUID } from 'node:crypto';
import type { Db, Tx } from '../db';
import { withTx } from '../db';
import { writeAudit } from '../audit';
import { unauthorized } from '../lib/errors';

export const ACCESS_TTL_SEC = 15 * 60;
export const REFRESH_TTL_SEC = 30 * 24 * 3600;

export type TokenPair = { accessToken: string; refreshToken: string; accessExpiresAt: string };

export async function createSession(tx: Tx, userId: string, deviceId: string | null, familyId = randomUUID()): Promise<TokenPair> {
  const accessToken = randomToken('sk_at_');
  const refreshToken = randomToken('sk_rt_');
  const r = await tx.query(
    `INSERT INTO sessions (user_id, device_id, family_id, access_hash, access_expires_at, refresh_hash, refresh_expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(secs => $5), $6, now() + make_interval(secs => $7))
     RETURNING access_expires_at`,
    [userId, deviceId, familyId, sha256(accessToken), ACCESS_TTL_SEC, sha256(refreshToken), REFRESH_TTL_SEC],
  );
  return { accessToken, refreshToken, accessExpiresAt: r.rows[0].access_expires_at.toISOString() };
}

/**
 * Rotating refresh tokens (ACC-03). Each refresh token works once. If an already-rotated token
 * is presented again, someone has a copy: the whole family is revoked and the user must log in again.
 */
export async function refreshSession(db: Db, refreshToken: string, ip: string): Promise<TokenPair> {
  const outcome = await withTx(db, async (tx) => {
    const r = await tx.query(
      `SELECT s.*, u.status AS user_status FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.refresh_hash = $1 FOR UPDATE OF s`,
      [sha256(refreshToken)],
    );
    const s = r.rows[0];
    if (!s || s.revoked_at || s.refresh_expires_at < new Date()) return null;
    if (s.user_status === 'suspended' || s.user_status === 'deleted') return null;
    if (s.rotated_at) {
      await tx.query(
        `UPDATE sessions SET revoked_at = now(), revoke_reason = 'refresh_reuse' WHERE family_id = $1 AND revoked_at IS NULL`,
        [s.family_id],
      );
      await writeAudit(tx, {
        actorType: 'system', action: 'session.refresh_reuse_detected', targetType: 'user', targetId: s.user_id,
        after: { familyId: s.family_id }, ip,
      });
      return 'reuse' as const;
    }
    await tx.query('UPDATE sessions SET rotated_at = now() WHERE id = $1', [s.id]);
    return createSession(tx, s.user_id, s.device_id, s.family_id);
  });
  if (!outcome || outcome === 'reuse') throw unauthorized();
  return outcome;
}

export async function revokeFamily(db: Db, familyId: string, reason: string): Promise<void> {
  await db.query(
    'UPDATE sessions SET revoked_at = now(), revoke_reason = $2 WHERE family_id = $1 AND revoked_at IS NULL',
    [familyId, reason],
  );
}

export async function revokeAllForUser(db: Db | Tx, userId: string, reason: string): Promise<void> {
  await db.query(
    'UPDATE sessions SET revoked_at = now(), revoke_reason = $2 WHERE user_id = $1 AND revoked_at IS NULL',
    [userId, reason],
  );
}
