import type { Queryable } from './db';

// Open flags of these kinds put a worker into manual review until ops resolve them.
export const BLOCKING_FLAGS = ['duplicate_identity', 'duplicate_face', 'duplicate_account', 'device_shared', 'selfie_kyc_mismatch', 'underage_report'];

/** Worker is verified once KYC, selfie, payout method and profile are all done and nothing is under review. */
export async function recomputeWorkerVerification(db: Queryable, userId: string): Promise<string> {
  const r = await db.query(
    `SELECT p.kyc_status, p.face_enrolled_at, p.profile_completed_at,
            EXISTS (SELECT 1 FROM payout_methods m WHERE m.worker_id = p.user_id AND m.status = 'verified') AS payout_ok,
            EXISTS (SELECT 1 FROM payout_methods m WHERE m.worker_id = p.user_id AND m.status = 'review') AS payout_review,
            EXISTS (SELECT 1 FROM fraud_flags f WHERE f.subject_type = 'worker' AND f.subject_id = p.user_id::text
                     AND f.status = 'open' AND f.rule_code = ANY($2)) AS flagged
       FROM worker_profiles p WHERE p.user_id = $1`,
    [userId, BLOCKING_FLAGS],
  );
  const p = r.rows[0];
  if (!p) return 'incomplete';
  let status = 'incomplete';
  if (p.kyc_status === 'rejected') status = 'rejected';
  else if (p.flagged || p.kyc_status === 'review' || p.payout_review) status = 'review';
  else if (p.kyc_status === 'verified' && p.face_enrolled_at && p.payout_ok && p.profile_completed_at) status = 'verified';
  await db.query('UPDATE worker_profiles SET verification_status = $2 WHERE user_id = $1 AND verification_status <> $2', [userId, status]);
  return status;
}
