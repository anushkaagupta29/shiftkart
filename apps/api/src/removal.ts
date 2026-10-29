import type { Db, Queryable, Tx } from './db';
import { withTx } from './db';
import { writeAudit } from './audit';
import { getPolicy } from './policy';
import { conflict, forbidden, notFound } from './lib/errors';
import { revokeAllForUser } from './auth/sessions';
import { notify } from './notify/notify';
import { istDate } from './time';

// Removing a worker (LEGAL L-03, D-091). The Karnataka gig workers act says a platform must not
// terminate a gig worker without valid reasons in writing and 14 days' prior notice. So staff never
// suspend a worker directly: they issue a notice, the worker can reply, and the removal happens
// only when the notice falls due (effectRemovals), unless staff withdraw it first.

/** The legal minimum; the policy can lengthen the notice but never shorten it. */
export const MIN_NOTICE_DAYS = 14;

type Staff = { staffId: string; roles: string[] };
type Keys = { dataKey: string };

export async function noticeDays(db: Queryable) {
  return Math.max(MIN_NOTICE_DAYS, await getPolicy<number>(db, 'removal.notice_days'));
}

export async function pendingNotice(db: Queryable, workerId: string) {
  return (await db.query(`SELECT * FROM removal_notices WHERE worker_id = $1 AND status = 'pending'`, [workerId])).rows[0] ?? null;
}

export function noticeRow(n: Record<string, any>) {
  return {
    id: n.id, status: n.status, reasons: n.reasons, interimHold: n.interim_hold, noticeDays: n.notice_days,
    issuedAt: n.issued_at, effectiveAt: n.effective_at, workerResponse: n.worker_response, respondedAt: n.responded_at,
    closedAt: n.closed_at, closeReason: n.close_reason,
  };
}

/**
 * Staff start removing a worker. `interimHold` (ops_safety only, for safety incidents) stops new
 * bookings straight away; the worker can still sign in, read the reasons and reply.
 */
export async function issueRemovalNotice(tx: Tx, keys: Keys, staff: Staff, workerId: string, reasons: string, interimHold: boolean, ip?: string) {
  if (interimHold && !staff.roles.includes('ops_safety')) throw forbidden('Only safety staff can put a worker on hold during the notice.');
  if (await pendingNotice(tx, workerId)) throw conflict('notice_pending', 'This worker already has a removal notice running.');
  const days = await noticeDays(tx);
  const n = (await tx.query(
    `INSERT INTO removal_notices (worker_id, reasons, notice_days, interim_hold, issued_by, effective_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $3)) RETURNING *`,
    [workerId, reasons, days, interimHold, staff.staffId],
  )).rows[0];
  await notify(tx, keys, { userId: workerId, template: 'removal_notice', vars: { date: istDate(n.effective_at), reasons, hold: interimHold ? 1 : 0 }, dedupeKey: `removal:${n.id}` });
  await writeAudit(tx, { actorType: 'staff', actorId: staff.staffId, actorRoles: staff.roles, action: 'worker.removal_notice', targetType: 'user', targetId: workerId, reason: reasons, after: { noticeId: n.id, effectiveAt: n.effective_at, interimHold }, ip });
  return n;
}

export async function withdrawRemovalNotice(tx: Tx, keys: Keys, staff: Staff, noticeId: string, reason: string, ip?: string) {
  const n = (await tx.query(
    `UPDATE removal_notices SET status = 'withdrawn', closed_by = $2, closed_at = now(), close_reason = $3
      WHERE id = $1 AND status = 'pending' RETURNING *`,
    [noticeId, staff.staffId, reason],
  )).rows[0];
  if (!n) throw conflict('not_pending', 'No running notice with this id.');
  await notify(tx, keys, { userId: n.worker_id, template: 'removal_withdrawn', vars: { reason }, dedupeKey: `removal-withdrawn:${n.id}` });
  await writeAudit(tx, { actorType: 'staff', actorId: staff.staffId, actorRoles: staff.roles, action: 'worker.removal_withdrawn', targetType: 'user', targetId: n.worker_id, reason, after: { noticeId: n.id }, ip });
  return n;
}

/** The worker's written reply. Staff see it before the notice falls due. */
export async function respondToNotice(db: Db, workerId: string, noticeId: string, response: string) {
  return withTx(db, async (tx) => {
    const n = (await tx.query(
      `UPDATE removal_notices SET worker_response = $3, responded_at = now() WHERE id = $1 AND worker_id = $2 AND status = 'pending' RETURNING *`,
      [noticeId, workerId, response],
    )).rows[0];
    if (!n) throw notFound();
    await writeAudit(tx, { actorType: 'user', actorId: workerId, action: 'worker.removal_response', targetType: 'removal_notice', targetId: noticeId });
    return noticeRow(n);
  });
}

/** Booking check: a safety hold during the notice means no new shifts. */
export async function assertNoInterimHold(db: Queryable, workerId: string) {
  const r = await db.query(`SELECT 1 FROM removal_notices WHERE worker_id = $1 AND status = 'pending' AND interim_hold`, [workerId]);
  if (r.rowCount) throw forbidden('Your account is on hold while a notice is open. You can read it and reply in the app.');
}

/** Job: remove workers whose notice has run its full term. Safe to run twice at once. */
export async function effectRemovals(db: Db, keys: Keys) {
  let done = 0;
  for (;;) {
    const ok = await withTx(db, async (tx) => {
      const n = (await tx.query(
        `SELECT * FROM removal_notices WHERE status = 'pending' AND effective_at <= now() ORDER BY effective_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
      )).rows[0];
      if (!n) return false;
      await tx.query(`UPDATE removal_notices SET status = 'effected', closed_at = now() WHERE id = $1`, [n.id]);
      await tx.query(`UPDATE users SET status = 'suspended' WHERE id = $1 AND status <> 'deleted'`, [n.worker_id]);
      await revokeAllForUser(tx, n.worker_id, 'removed');
      await notify(tx, keys, { userId: n.worker_id, template: 'removal_effective', dedupeKey: `removal-effective:${n.id}` });
      await writeAudit(tx, { actorType: 'system', action: 'worker.removed', targetType: 'user', targetId: n.worker_id, reason: n.reasons, after: { noticeId: n.id, status: 'suspended' } });
      return true;
    });
    if (!ok) return done;
    done += 1;
  }
}
