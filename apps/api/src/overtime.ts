import { randomUUID } from 'node:crypto';
import { applyBasisPoints, decrypt } from '@shiftkart/shared';
import type { Db } from './db';
import { withTx } from './db';
import { writeAudit } from './audit';
import { getPolicies } from './policy';
import { badRequest, conflict, notFound } from './lib/errors';
import { newProviderRef } from './adapters/mockpay';
import type { SmsSender } from './adapters/sms';

/**
 * Overtime must be agreed in the app (SPEC §6.7): the business asks and pays the extra into escrow
 * first (PAY-07); only then does the worker see it and decide. Paid at the overtime rate.
 */
export async function requestOvertime(db: Db, biz: { businessId: string; userId: string }, bookingId: string, extraMinutes: number, ip: string) {
  return withTx(db, async (tx) => {
    const b = (await tx.query(
      `SELECT b.*, s.business_id, s.pay_type, s.pay_paise, s.starts_at AS s_start, s.ends_at AS s_end, s.break_minutes, s.cost
         FROM bookings b JOIN shifts s ON s.id = b.shift_id WHERE b.id = $1 FOR UPDATE OF b`,
      [bookingId],
    )).rows[0];
    if (!b || b.business_id !== biz.businessId) throw notFound();
    if (b.status !== 'checked_in') throw conflict('bad_state', 'Overtime can be asked for while the worker is on shift.');
    const pol = await getPolicies(tx, ['overtime.multiplier_bp', 'booking.max_hours_day']);
    const already = (await tx.query(`SELECT COALESCE(sum(extra_minutes), 0)::int AS m FROM overtime_requests WHERE booking_id = $1 AND status = 'accepted'`, [bookingId])).rows[0].m;
    const shiftMin = (b.s_end.getTime() - b.s_start.getTime()) / 60_000;
    if (shiftMin + already + extraMinutes > pol['booking.max_hours_day'] * 60) throw conflict('daily_hours_cap', `That would take the day over ${pol['booking.max_hours_day']} hours.`);
    const paidMin = shiftMin - b.break_minutes;
    const hourly = b.pay_type === 'hourly' ? Number(b.pay_paise) : Math.floor((Number(b.pay_paise) * 60) / paidMin);
    const workerPay = Number((BigInt(hourly) * BigInt(extraMinutes) * BigInt(pol['overtime.multiplier_bp']) * 2n + 600_000n) / 1_200_000n);
    const fee = applyBasisPoints(workerPay, b.cost.feeBp);
    const gst = applyBasisPoints(fee, b.cost.gstBp);
    let ot;
    try {
      ot = (await tx.query(
        `INSERT INTO overtime_requests (booking_id, shift_id, extra_minutes, multiplier_bp, worker_pay_paise, fee_paise, gst_paise, total_paise, requested_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [bookingId, b.shift_id, extraMinutes, pol['overtime.multiplier_bp'], workerPay, fee, gst, workerPay + fee + gst, biz.userId],
      )).rows[0];
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw conflict('overtime_open', 'There is already an overtime request for this worker.');
      throw e;
    }
    const intent = (await tx.query(
      `INSERT INTO payment_intents (business_id, shift_id, amount_paise, provider, provider_ref, idempotency_key, purpose, overtime_request_id)
       VALUES ($1, $2, $3, 'mockpay', $4, $5, 'overtime', $6) RETURNING id`,
      [biz.businessId, b.shift_id, ot.total_paise, newProviderRef(), `${biz.businessId}:ot:${ot.id}:${randomUUID()}`, ot.id],
    )).rows[0];
    await writeAudit(tx, { actorType: 'user', actorId: biz.userId, action: 'overtime.request', targetType: 'booking', targetId: bookingId, after: { extraMinutes, totalPaise: ot.total_paise }, ip });
    return { id: ot.id as string, status: ot.status as string, workerPayPaise: workerPay, totalPaise: Number(ot.total_paise), intentId: intent.id as string, checkoutPath: `/pay/${intent.id}` };
  });
}

/** Called from the payment webhook once the top-up is captured. */
export async function overtimeFunded(tx: import('./db').Tx, overtimeRequestId: string, sms?: SmsSender, dataKey?: string) {
  const ot = (await tx.query(
    `UPDATE overtime_requests SET status = 'awaiting_worker' WHERE id = $1 AND status = 'awaiting_funding' RETURNING *`, [overtimeRequestId],
  )).rows[0];
  if (ot && sms && dataKey) {
    const u = (await tx.query('SELECT u.phone_enc FROM bookings b JOIN users u ON u.id = b.worker_id WHERE b.id = $1', [ot.booking_id])).rows[0];
    await sms.send(decrypt(u.phone_enc, dataKey), `ShiftKart: overtime offered, ${ot.extra_minutes} min for ₹${(Number(ot.worker_pay_paise) / 100).toFixed(2)}. Accept or decline in the app.`);
  }
  return ot;
}

export async function respondOvertime(db: Db, workerId: string, otId: string, accept: boolean, ip: string) {
  return withTx(db, async (tx) => {
    const ot = (await tx.query(
      `SELECT o.* FROM overtime_requests o JOIN bookings b ON b.id = o.booking_id WHERE o.id = $1 AND b.worker_id = $2 FOR UPDATE OF o`,
      [otId, workerId],
    )).rows[0];
    if (!ot) throw notFound();
    if (ot.status !== 'awaiting_worker') throw conflict('not_open', ot.status === 'awaiting_funding' ? 'Waiting for the business to pay for the overtime.' : 'This overtime offer is closed.');
    const b = (await tx.query('SELECT status FROM bookings WHERE id = $1', [ot.booking_id])).rows[0];
    if (accept && b.status !== 'checked_in') throw badRequest('not_on_shift', 'You are no longer on this shift.');
    await tx.query(`UPDATE overtime_requests SET status = $2, worker_responded_at = now() WHERE id = $1`, [otId, accept ? 'accepted' : 'declined']);
    await writeAudit(tx, { actorType: 'user', actorId: workerId, action: accept ? 'overtime.accept' : 'overtime.decline', targetType: 'booking', targetId: ot.booking_id, ip });
    // Declined overtime money stays in escrow and is refunded when the shift settles.
    return { status: accept ? 'accepted' : 'declined', extraMinutes: ot.extra_minutes, workerPayPaise: Number(ot.worker_pay_paise) };
  });
}
