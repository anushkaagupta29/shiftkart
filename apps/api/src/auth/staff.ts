import { decrypt, hashPassword, randomToken, sha256, verifyPassword, verifyTotp } from '@shiftkart/shared';
import type { Db } from '../db';
import { withTx } from '../db';
import { writeAudit } from '../audit';
import { HttpError, tooMany } from '../lib/errors';

export const STAFF_SESSION_HOURS = 8;
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

// Compared against when the email doesn't exist, so response time doesn't reveal valid emails.
const DUMMY_HASH = await hashPassword('dummy-password-for-timing');

export async function staffLogin(db: Db, dataKey: string, input: { email: string; password: string; totp: string }, ip: string) {
  const r = await db.query('SELECT * FROM staff_users WHERE email = $1', [input.email]);
  const s = r.rows[0];
  const invalid = new HttpError(401, 'invalid_credentials', 'Email, password or 2FA code is wrong.');
  if (!s) {
    await verifyPassword(input.password, DUMMY_HASH);
    throw invalid;
  }
  if (s.status !== 'active') throw invalid;
  if (s.locked_until && s.locked_until > new Date()) {
    throw tooMany('staff_locked', 'Too many failed attempts. Try again in 15 minutes.', (s.locked_until.getTime() - Date.now()) / 1000);
  }

  const pwOk = await verifyPassword(input.password, s.password_hash);
  const step = pwOk ? verifyTotp(decrypt(s.totp_secret_enc, dataKey), input.totp) : null;
  // A TOTP code can only be used once (step must move forward), so a shoulder-surfed code can't be replayed.
  const ok = pwOk && step !== null && step > Number(s.last_totp_step);

  return withTx(db, async (tx) => {
    if (!ok) {
      await tx.query(
        `UPDATE staff_users SET failed_logins = failed_logins + 1,
                locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
          WHERE id = $1`,
        [s.id, MAX_FAILED, LOCK_MINUTES],
      );
      await writeAudit(tx, { actorType: 'staff', actorId: s.id, actorRoles: s.roles, action: 'staff.login_failed', targetType: 'staff', targetId: s.id, ip });
      return { error: invalid } as const;
    }
    const token = randomToken('sk_st_');
    await tx.query(
      `UPDATE staff_users SET failed_logins = 0, locked_until = NULL, last_totp_step = $2, last_login_at = now() WHERE id = $1`,
      [s.id, step],
    );
    await tx.query(
      `INSERT INTO staff_sessions (staff_id, token_hash, expires_at, ip) VALUES ($1, $2, now() + make_interval(hours => $3), $4)`,
      [s.id, sha256(token), STAFF_SESSION_HOURS, ip],
    );
    await writeAudit(tx, { actorType: 'staff', actorId: s.id, actorRoles: s.roles, action: 'staff.login', targetType: 'staff', targetId: s.id, ip });
    return { token, staff: { id: s.id, email: s.email, name: s.name, roles: s.roles as string[], mustChangePassword: s.password_must_change as boolean } } as const;
  }).then((res) => {
    if ('error' in res) throw res.error;
    return res;
  });
}
