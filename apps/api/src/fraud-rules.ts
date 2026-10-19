import type { Queryable, Tx } from './db';
import { raiseFlag } from './fraud';
import { getPolicies, getPolicy } from './policy';
import { forbidden } from './lib/errors';

/**
 * MON-01: a worker taking shifts from a business they're connected to (same phone as a business
 * member) can farm incentives or move money. Refused and flagged for review.
 */
export async function assertNoSelfDealing(tx: Queryable, workerId: string, businessId: string) {
  const link = await tx.query(
    `SELECT DISTINCT m.user_id FROM devices wd
       JOIN devices md ON md.device_id_hash = wd.device_id_hash
       JOIN business_members m ON m.user_id = md.user_id AND m.business_id = $2 AND m.removed_at IS NULL
      WHERE wd.user_id = $1`,
    [workerId, businessId],
  );
  if (link.rowCount) {
    await raiseFlag(tx, 'worker', workerId, 'business_worker_device_link', { businessId, members: link.rows.map((r) => r.user_id) }, 85);
    await raiseFlag(tx, 'business', businessId, 'business_worker_device_link', { workerId }, 85);
    throw forbidden('You can\'t take shifts from this business. Contact support if this is a mistake.');
  }
}

/**
 * MON-02: a brand-new business that funds and completes a shift within a day, paying mostly
 * brand-new workers, looks like a money-moving pattern. Flag for finance review at settlement.
 */
export async function velocityCheck(tx: Tx, shift: Record<string, any>) {
  const pol = await getPolicies(tx, ['velocity.new_business_workers', 'business.new_days']);
  const b = (await tx.query('SELECT verified_at FROM businesses WHERE id = $1', [shift.business_id])).rows[0];
  if (!b?.verified_at || Date.now() - b.verified_at.getTime() > pol['business.new_days'] * 86400_000) return;
  if (!shift.published_at || shift.ends_at.getTime() - shift.published_at.getTime() > 24 * 3600_000) return;
  const fresh = (await tx.query(
    `SELECT count(*)::int AS n FROM timesheets t JOIN worker_profiles p ON p.user_id = t.worker_id
      WHERE t.shift_id = $1 AND p.completed_shifts <= 1 AND t.status IN ('approved', 'auto_approved', 'resolved')`,
    [shift.id],
  )).rows[0].n;
  if (fresh >= pol['velocity.new_business_workers']) {
    await raiseFlag(tx, 'business', shift.business_id, 'velocity_new_business', { shiftId: shift.id, newWorkersPaid: fresh }, 70);
  }
}

/** INT-04: a random sample of approved businesses is sent for a second look by someone else. */
export async function maybeSampleForRereview(tx: Tx, businessId: string, approverId: string) {
  const bp = await getPolicy<number>(tx, 'review.random_sample_bp');
  if (Math.random() * 10_000 < bp) await raiseFlag(tx, 'business', businessId, 'random_rereview', { approvedBy: approverId }, 20);
}

/** INT-05: staff reading an unusual number of personal records in an hour is flagged. */
export async function recordStaffRead(db: Queryable, staffId: string, resource: string) {
  await db.query('INSERT INTO staff_reads (staff_id, resource) VALUES ($1, $2)', [staffId, resource]);
  const limit = await getPolicy<number>(db, 'staff.read_alert_per_hour');
  const n = (await db.query(`SELECT count(*)::int AS n FROM staff_reads WHERE staff_id = $1 AND at > now() - interval '1 hour'`, [staffId])).rows[0].n;
  if (n > limit) await raiseFlag(db, 'staff', staffId, 'staff_read_volume', { readsLastHour: n }, 80);
}

/** PAY-08: a business whose ratings are mostly 1–2 stars is reviewed itself. */
export async function harshRaterCheck(db: Queryable, businessId: string) {
  const pol = await getPolicies(db, ['ratings.harsh_rater_bp', 'ratings.harsh_rater_min']);
  const r = (await db.query(
    `SELECT count(*)::int AS n, count(*) FILTER (WHERE stars <= 2)::int AS low FROM ratings WHERE rater_type = 'business' AND rater_id = $1`, [businessId])).rows[0];
  if (r.n >= pol['ratings.harsh_rater_min'] && r.low * 10_000 > r.n * pol['ratings.harsh_rater_bp']) {
    await raiseFlag(db, 'business', businessId, 'harsh_rater', { ratings: r.n, lowRatings: r.low }, 50);
  }
}

/** BIZ-05: repeated "the work didn't match the post" reports put the business under review. */
export async function mismatchCheck(db: Queryable, businessId: string) {
  const limit = await getPolicy<number>(db, 'mismatch.flag_count');
  const n = (await db.query(
    `SELECT count(*)::int AS n FROM incidents WHERE business_id = $1 AND category = 'work_mismatch' AND created_at > now() - interval '30 days'`, [businessId])).rows[0].n;
  if (n >= limit) await raiseFlag(db, 'business', businessId, 'work_mismatch_reports', { reports: n }, 55);
}
