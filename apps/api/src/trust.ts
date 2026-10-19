import { applyBasisPoints, decrypt } from '@shiftkart/shared';
import type { Db, Queryable, Tx } from './db';
import { withTx } from './db';
import { writeAudit } from './audit';
import { raiseFlag } from './fraud';
import { getPolicies, getPolicy } from './policy';
import { HttpError, badRequest, conflict, forbidden, notFound } from './lib/errors';
import { postJournal, shiftEscrow, workerPayable } from './ledger';
import { offerNextOrRelease } from './booking';
import { settleShift } from './money';
import type { PayoutProvider } from './adapters/payouts';
import type { SmsSender } from './adapters/sms';

type Notify = { sms: SmsSender; dataKey: string };

async function textWorker(tx: Queryable, n: Notify | undefined, workerId: string, body: string) {
  if (!n) return;
  const u = (await tx.query('SELECT phone_enc FROM users WHERE id = $1', [workerId])).rows[0];
  if (u) await n.sms.send(decrypt(u.phone_enc, n.dataKey), body);
}

/** Pays a worker from the shift's escrow without a platform fee (we take nothing from cancellations). */
async function payCompensation(tx: Tx, shift: Record<string, any>, booking: Record<string, any>, reason: 'late_cancel' | 'turned_away' | 'site_paused', amount: number, rule: object, hoursBefore: number | null) {
  await tx.query(
    `INSERT INTO compensations (booking_id, shift_id, worker_id, reason, hours_before, rule, amount_paise) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [booking.id, shift.id, booking.worker_id, reason, hoursBefore, JSON.stringify(rule), amount],
  );
  if (amount <= 0) return;
  const key = `comp:${booking.id}`;
  await postJournal(tx, { kind: 'compensation', refType: 'shift', refId: shift.id, idempotencyKey: key, memo: reason }, [
    { account: shiftEscrow(shift.id), type: 'shift_escrow', ownerId: shift.business_id, amountPaise: -amount },
    { account: workerPayable(booking.worker_id), type: 'worker_payable', ownerId: booking.worker_id, amountPaise: amount },
  ], { nonNegative: [shiftEscrow(shift.id)] });
  await tx.query(
    `INSERT INTO payouts (worker_id, booking_id, kind, amount_paise, status, idempotency_key, journal_key, reason)
     VALUES ($1, $2, 'compensation', $3, 'queued', $4, $5, $6) ON CONFLICT (idempotency_key) DO NOTHING`,
    [booking.worker_id, booking.id, amount, `payout:${key}`, key, reason],
  );
}

/** Turn-away pay: max(N hours of pay, X% of the shift), capped at full pay, plus the travel allowance. */
async function turnAwayAmount(tx: Tx, shift: Record<string, any>) {
  const pol = await getPolicies(tx, ['cancel.turnaway.min_hours', 'cancel.turnaway.min_bp']);
  const perWorker = Number(shift.cost.perWorkerPayPaise);
  const hourly = Number(shift.cost.effectiveHourlyPaise);
  const amount = Math.min(perWorker, Math.max(hourly * pol['cancel.turnaway.min_hours'], applyBasisPoints(perWorker, pol['cancel.turnaway.min_bp'])));
  return { amount: amount + Number(shift.travel_allowance_paise), rule: { minHours: pol['cancel.turnaway.min_hours'], minBp: pol['cancel.turnaway.min_bp'], travelAllowance: Number(shift.travel_allowance_paise) } };
}

/**
 * Business (or ops, or a safety pause) cancels a funded, live shift. Workers are compensated
 * automatically from the money already in escrow, by how late the cancellation is (SPEC §6.7):
 * workers who already checked in get the turn-away minimum. The rest is refunded to the business.
 */
export async function cancelLiveShift(
  db: Db, provider: PayoutProvider, shiftId: string,
  by: { kind: 'business' | 'ops' | 'site_paused'; userId?: string; staffId?: string; businessId?: string },
  reason: string, notify?: Notify, ip?: string,
) {
  const result = await withTx(db, async (tx) => {
    const s = (await tx.query('SELECT * FROM shifts WHERE id = $1 FOR UPDATE', [shiftId])).rows[0];
    if (!s || (by.businessId && s.business_id !== by.businessId)) throw notFound();
    if (s.status !== 'live') throw conflict('not_live', 'Only live shifts can be cancelled this way.');
    const hoursBefore = (s.starts_at.getTime() - Date.now()) / 3600_000;
    const windows = (await getPolicy<{ beforeHours: number; workerCompBp: number }[]>(tx, 'cancel.business.windows')).slice().sort((a, b) => b.beforeHours - a.beforeHours);
    const window = windows.find((w) => hoursBefore >= w.beforeHours) ?? windows[windows.length - 1]!;
    const compReason = by.kind === 'site_paused' ? 'site_paused' : 'late_cancel';

    const bookings = (await tx.query(`SELECT * FROM bookings WHERE shift_id = $1 AND status IN ('confirmed', 'checked_in') FOR UPDATE`, [shiftId])).rows;
    let total = 0;
    for (const b of bookings) {
      if (b.status === 'checked_in') {
        const t = await turnAwayAmount(tx, s);
        await payCompensation(tx, s, b, 'turned_away', t.amount, t.rule, Math.round(hoursBefore * 100) / 100);
        await tx.query(`UPDATE bookings SET status = 'turned_away', turned_away_at = now(), turn_away_reason = $2 WHERE id = $1`, [b.id, reason]);
        total += t.amount;
      } else {
        const amount = applyBasisPoints(Number(s.cost.perWorkerPayPaise), window.workerCompBp);
        await payCompensation(tx, s, b, compReason, amount, { window, hoursBefore: Math.round(hoursBefore * 100) / 100 }, Math.round(hoursBefore * 100) / 100);
        await tx.query(`UPDATE bookings SET status = 'cancelled_business', cancelled_at = now(), cancel_hours_before = $2 WHERE id = $1`, [b.id, Math.max(-999, Math.round(hoursBefore * 100) / 100)]);
        total += amount;
      }
      await textWorker(tx, notify, b.worker_id, cancelMessage(b, s));
    }
    await tx.query(`UPDATE waitlist_entries SET status = 'expired' WHERE shift_id = $1 AND status IN ('waiting', 'offered')`, [shiftId]);
    await tx.query(`UPDATE shifts SET status = 'cancelled', cancelled_at = now(), cancel_reason = $2, cancelled_by = $3, filled_count = 0 WHERE id = $1`, [shiftId, reason, by.kind]);
    if (by.kind === 'business' && hoursBefore < 24) await checkLateCancelPattern(tx, s.business_id);
    await writeAudit(tx, {
      actorType: by.staffId ? 'staff' : by.userId ? 'user' : 'system', actorId: by.staffId ?? by.userId ?? null,
      action: 'shift.cancel_live', targetType: 'shift', targetId: shiftId, reason, after: { hoursBefore: Math.round(hoursBefore * 10) / 10, workers: bookings.length, compensationPaise: total, by: by.kind }, ip,
    });
    return { workers: bookings.length, compensationPaise: total, window };
  });
  // Unused money goes straight back to the business (unless someone is still mid-timesheet).
  await settleShift(db, provider, shiftId);
  return result;

  function cancelMessage(b: Record<string, any>, s: Record<string, any>) {
    return `ShiftKart: "${s.title}" was cancelled by the business. ${b.status === 'checked_in' ? 'You have been paid the turn-away amount.' : 'Any compensation due is on its way to your account.'} This does not affect your score.`;
  }
}

/** PAY-11: a worker who arrived and was sent away (site not ready) gets the turn-away minimum. */
export async function turnAway(db: Db, biz: { businessId: string; userId: string }, bookingId: string, reason: string, notify?: Notify, ip?: string) {
  return withTx(db, async (tx) => {
    const b = (await tx.query(`SELECT b.*, s.business_id FROM bookings b JOIN shifts s ON s.id = b.shift_id WHERE b.id = $1 FOR UPDATE OF b`, [bookingId])).rows[0];
    if (!b || b.business_id !== biz.businessId) throw notFound();
    if (b.status !== 'checked_in') throw conflict('not_checked_in', 'Only workers who have checked in can be turned away. Others are covered by cancellation rules.');
    const s = (await tx.query('SELECT * FROM shifts WHERE id = $1 FOR UPDATE', [b.shift_id])).rows[0];
    const t = await turnAwayAmount(tx, s);
    await payCompensation(tx, s, b, 'turned_away', t.amount, t.rule, null);
    await tx.query(`UPDATE bookings SET status = 'turned_away', turned_away_at = now(), turn_away_reason = $2 WHERE id = $1`, [bookingId, reason]);
    await textWorker(tx, notify, b.worker_id, `ShiftKart: you were sent home from "${s.title}". You are being paid ₹${(t.amount / 100).toFixed(2)} for turning up.`);
    await writeAudit(tx, { actorType: 'user', actorId: biz.userId, action: 'booking.turned_away', targetType: 'booking', targetId: bookingId, reason, after: { amountPaise: t.amount }, ip });
    return { status: 'turned_away', compensationPaise: t.amount };
  });
}

/** PAY-03: a business that keeps cancelling late gets its new shifts reviewed by ops. */
async function checkLateCancelPattern(tx: Tx, businessId: string) {
  const pol = await getPolicies(tx, ['business.late_cancel_flag_count', 'business.late_cancel_window_days']);
  const r = (await tx.query(
    `SELECT count(*)::int AS n FROM shifts WHERE business_id = $1 AND cancelled_by = 'business'
        AND cancelled_at > now() - make_interval(days => $2) AND starts_at - cancelled_at < interval '24 hours'`,
    [businessId, pol['business.late_cancel_window_days']],
  )).rows[0];
  if (r.n >= pol['business.late_cancel_flag_count']) await raiseFlag(tx, 'business', businessId, 'late_cancel_pattern', { lateCancels: r.n }, 60);
}

// ------------------------------------------------------------------ strikes

const STRIKE_KEYS = ['strikes.late_cancel_hours', 'strikes.points.late_cancel', 'strikes.points.no_show', 'strikes.expiry_days', 'strikes.emergency_per_90d'] as const;

/** Points that count right now: active or under appeal, not expired, within the window. */
export async function strikePoints(db: Queryable, workerId: string) {
  const pol = await getPolicies(db, ['strikes.window_days', 'strikes.limit_threshold', 'strikes.suspend_threshold']);
  const r = (await db.query(
    `SELECT COALESCE(sum(points), 0)::int AS p FROM strikes WHERE worker_id = $1 AND status IN ('active', 'appealed', 'upheld')
        AND expires_at > now() AND created_at > now() - make_interval(days => $2)`,
    [workerId, pol['strikes.window_days']],
  )).rows[0].p as number;
  const level = r >= pol['strikes.suspend_threshold'] ? 'on_hold' : r >= pol['strikes.limit_threshold'] ? 'limited' : 'ok';
  return { points: r, level: level as 'ok' | 'limited' | 'on_hold', limitAt: pol['strikes.limit_threshold'], holdAt: pol['strikes.suspend_threshold'] };
}

async function afterStrike(tx: Tx, workerId: string) {
  const s = await strikePoints(tx, workerId);
  const active90 = (await tx.query(`SELECT COALESCE(sum(points), 0)::int AS p FROM strikes WHERE worker_id = $1 AND status IN ('active', 'appealed', 'upheld') AND expires_at > now()`, [workerId])).rows[0].p;
  await tx.query(`UPDATE worker_profiles SET reliability_score = GREATEST(0, 100 - 10 * $2), limited_until = CASE WHEN $3 = 'ok' THEN NULL ELSE now() + make_interval(days => CASE WHEN $3 = 'on_hold' THEN 30 ELSE 7 END) END WHERE user_id = $1`,
    [workerId, active90, s.level]);
  // Never an automatic permanent ban: a hold goes to a human (SPEC §6.7).
  if (s.level === 'on_hold') await raiseFlag(tx, 'worker', workerId, 'strike_hold_review', { points: s.points }, 50);
  return s;
}

/**
 * A worker's late cancellation or no-show. Emergencies (up to the limit) are excused without
 * proof; beyond the limit the claim becomes an appeal a person reviews (WRK-10).
 */
export async function recordStrike(tx: Tx, workerId: string, bookingId: string, kind: 'late_cancel' | 'no_show', hoursBefore: number | null, emergency?: { reason: string }) {
  const pol = await getPolicies(tx, STRIKE_KEYS);
  let status = 'active';
  let appealReason: string | null = null;
  if (emergency) {
    const used = (await tx.query(
      `SELECT count(*)::int AS n FROM strikes WHERE worker_id = $1 AND emergency AND status = 'excused' AND created_at > now() - interval '90 days'`, [workerId])).rows[0].n;
    if (used < pol['strikes.emergency_per_90d']) status = 'excused';
    else { status = 'appealed'; appealReason = `Emergency claimed (limit of ${pol['strikes.emergency_per_90d']} in 90 days reached): ${emergency.reason}`; }
  }
  const points = kind === 'no_show' ? pol['strikes.points.no_show'] : pol['strikes.points.late_cancel'];
  await tx.query(
    `INSERT INTO strikes (worker_id, booking_id, kind, points, status, emergency, hours_before, expires_at, appeal_reason, appealed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(days => $8), $9, CASE WHEN $9::text IS NULL THEN NULL ELSE now() END)
     ON CONFLICT (booking_id, kind) DO NOTHING`,
    [workerId, bookingId, kind, points, status, Boolean(emergency), hoursBefore, pol['strikes.expiry_days'], appealReason],
  );
  const after = await afterStrike(tx, workerId);
  return { status, strikePoints: points, totalPoints: after.points, level: after.level };
}

export async function lateCancelHours(db: Queryable) { return getPolicy<number>(db, 'strikes.late_cancel_hours'); }

export async function appealStrike(db: Db, workerId: string, strikeId: string, reason: string) {
  return withTx(db, async (tx) => {
    const r = await tx.query(
      `UPDATE strikes SET status = 'appealed', appeal_reason = $3, appealed_at = now() WHERE id = $1 AND worker_id = $2 AND status = 'active' RETURNING id`,
      [strikeId, workerId, reason],
    );
    if (!r.rowCount) throw conflict('not_appealable', 'This strike cannot be appealed (already appealed, decided or excused).');
    await writeAudit(tx, { actorType: 'user', actorId: workerId, action: 'strike.appeal', targetType: 'strike', targetId: strikeId, reason });
    return { status: 'appealed' };
  });
}

export async function decideAppeal(db: Db, staff: { staffId: string; roles: string[] }, strikeId: string, overturn: boolean, reason: string, notify?: Notify, ip?: string) {
  return withTx(db, async (tx) => {
    const s = (await tx.query(
      `UPDATE strikes SET status = $2, decision_reason = $3, decided_by = $4, decided_at = now() WHERE id = $1 AND status = 'appealed' RETURNING *`,
      [strikeId, overturn ? 'overturned' : 'upheld', reason, staff.staffId],
    )).rows[0];
    if (!s) throw conflict('not_appealed', 'No open appeal on this strike.');
    await afterStrike(tx, s.worker_id);
    await textWorker(tx, notify, s.worker_id, `ShiftKart: your appeal was ${overturn ? 'accepted. The strike is removed' : 'not accepted'}. ${reason}`);
    await writeAudit(tx, { actorType: 'staff', actorId: staff.staffId, actorRoles: staff.roles, action: overturn ? 'strike.overturned' : 'strike.upheld', targetType: 'strike', targetId: strikeId, reason, ip });
    return { status: overturn ? 'overturned' : 'upheld' };
  });
}

/** Worker cancels: slot passes on (waitlist), and a late cancellation earns a strike unless excused. */
export async function cancelByWorker(db: Db, workerId: string, bookingId: string, opts: { emergency?: { reason: string } }, notify: Notify) {
  return withTx(db, async (tx) => {
    const b0 = (await tx.query('SELECT shift_id FROM bookings WHERE id = $1 AND worker_id = $2', [bookingId, workerId])).rows[0];
    if (!b0) throw new HttpError(404, 'not_found', 'Booking not found.');
    await tx.query('SELECT 1 FROM shifts WHERE id = $1 FOR UPDATE', [b0.shift_id]);
    const b = (await tx.query(
      `UPDATE bookings SET status = 'cancelled_worker', cancelled_at = now(),
              cancel_hours_before = round((EXTRACT(EPOCH FROM starts_at - now()) / 3600)::numeric, 2)
        WHERE id = $1 AND status = 'confirmed' AND starts_at > now() RETURNING *`,
      [bookingId],
    )).rows[0];
    if (!b) throw conflict('not_cancellable', 'This booking can no longer be cancelled here.');
    const slot = await offerNextOrRelease(tx, b.shift_id, notify.sms, notify.dataKey);
    const hours = Number(b.cancel_hours_before);
    let strike = null;
    if (hours < (await lateCancelHours(tx))) strike = await recordStrike(tx, workerId, bookingId, 'late_cancel', hours, opts.emergency);
    else if (opts.emergency) throw badRequest('not_needed', 'You are cancelling early enough: no emergency needed.');
    await writeAudit(tx, { actorType: 'user', actorId: workerId, action: 'booking.cancel_worker', targetType: 'booking', targetId: bookingId, after: { hoursBefore: hours, strike: strike?.status ?? null } });
    return { id: b.id, status: b.status, hoursBefore: hours, slot, strike };
  });
}

/** Can this worker take another shift? Used by booking (limited = 1 upcoming shift; on hold = none). */
export async function assertNotOnHold(tx: Queryable, workerId: string) {
  const s = await strikePoints(tx, workerId);
  if (s.level === 'on_hold') throw forbidden(`Your account is on hold for review after ${s.points} strike points. You can appeal strikes in the app.`);
  return s;
}
