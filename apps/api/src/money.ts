import { applyBasisPoints, decrypt } from '@shiftkart/shared';
import type { Db, Tx } from './db';
import { withTx } from './db';
import { writeAudit } from './audit';
import { raiseFlag } from './fraud';
import { getPolicies } from './policy';
import { badRequest, conflict, forbidden, notFound } from './lib/errors';
import {
  CHARGEBACK_LOSS, GST_PAYABLE, PLATFORM_ADJUSTMENTS, PLATFORM_REVENUE, accountBalance, clearingAccount, postJournal, shiftEscrow, workerPayable,
} from './ledger';
import { payForMinutes } from './domain/timesheet';
import { financialYear, gstSplit } from './domain/gst';
import { istDate } from './time';
import type { PayoutProvider } from './adapters/payouts';
import type { SmsSender } from './adapters/sms';
import { recordStrike } from './trust';
import { velocityCheck } from './fraud-rules';
import { caseEvent, openCase } from './cases';
import { notify } from './notify/notify';

const PROVIDER = 'mockpay';
// Placeholder seller details until the company is registered (LEGAL L-32, L-12).
export const SELLER = { legalName: 'ShiftKart (company not yet registered)', gstin: 'GSTIN-PENDING', stateCode: 'KA', sac: '998519 (to confirm)' };

type Timesheet = Record<string, any>;

/**
 * Fee and GST for a timesheet, computed per funded component (base pay, overtime) exactly as they
 * were when the business funded them, so a release can never exceed what's in escrow by a paisa.
 */
function feesFor(t: Timesheet) {
  const bp = (x: number, r: number) => applyBasisPoints(x, r);
  const base = Number(t.base_pay_paise), ot = Number(t.overtime_pay_paise);
  const fee = bp(base, t.fee_bp) + bp(ot, t.fee_bp);
  const gst = bp(bp(base, t.fee_bp), t.gst_bp) + bp(bp(ot, t.fee_bp), t.gst_bp);
  return { fee, gst, ofPay: (x: number) => ({ fee: bp(x, t.fee_bp), gst: bp(bp(x, t.fee_bp), t.gst_bp) }) };
}

/**
 * Releases money for (part of) a timesheet: moves it out of the shift's escrow into the worker's
 * payable account, books our fee and GST on the fee, and queues a payout. Idempotent on `key`.
 * Fee is charged on worker pay only (not allowances), at the rates frozen when the shift was posted.
 */
async function release(tx: Tx, t: Timesheet, amount: number, fee: number, gst: number, key: string, kind: 'wage' | 'dispute_award') {
  if (amount <= 0) return null;
  const j = await postJournal(tx, { kind: 'fee', refType: 'shift', refId: t.shift_id, idempotencyKey: key, memo: `timesheet ${t.id}` }, [
    { account: shiftEscrow(t.shift_id), type: 'shift_escrow', ownerId: t.business_id, amountPaise: -(amount + fee + gst) },
    { account: workerPayable(t.worker_id), type: 'worker_payable', ownerId: t.worker_id, amountPaise: amount },
    ...(fee ? [{ account: PLATFORM_REVENUE, type: 'revenue', amountPaise: fee }] : []),
    ...(gst ? [{ account: GST_PAYABLE, type: 'tax', amountPaise: gst }] : []),
  ], { nonNegative: [shiftEscrow(t.shift_id)] });
  if (j.duplicate) return null;
  await tx.query(
    `INSERT INTO payouts (worker_id, timesheet_id, kind, amount_paise, status, idempotency_key, journal_key)
     VALUES ($1, $2, $3, $4, 'queued', $5, $6) ON CONFLICT (idempotency_key) DO NOTHING`,
    [t.worker_id, t.id, kind, amount, `payout:${key}`, key],
  );
  return { amount, fee, gst };
}

export async function approveTimesheet(db: Db, t0: { id: string; businessId: string }, by: { userId: string } | 'auto', ip?: string) {
  return withTx(db, async (tx) => {
    // Lock order: shift, then timesheet (same as settlement), so approval and refund can't race (SYS-05).
    const s = (await tx.query('SELECT shift_id FROM timesheets WHERE id = $1 AND business_id = $2', [t0.id, t0.businessId])).rows[0];
    if (!s) throw notFound();
    await tx.query('SELECT 1 FROM shifts WHERE id = $1 FOR UPDATE', [s.shift_id]);
    const t = (await tx.query('SELECT * FROM timesheets WHERE id = $1 FOR UPDATE', [t0.id])).rows[0];
    if (t.status !== 'pending_approval') throw conflict('not_pending', 'This timesheet is not waiting for approval.');
    const auto = by === 'auto';
    if (auto && t.approval_deadline > new Date()) throw conflict('not_due', 'Not due yet.');
    await tx.query(
      `UPDATE timesheets SET status = $2, approved_by = $3, approved_at = now() WHERE id = $1`,
      [t.id, auto ? 'auto_approved' : 'approved', auto ? null : by.userId],
    );
    await tx.query('UPDATE worker_profiles SET completed_shifts = completed_shifts + 1 WHERE user_id = $1', [t.worker_id]);
    const f = feesFor(t);
    const r = await release(tx, t, Number(t.gross_paise), f.fee, f.gst, `approve:${t.id}`, 'wage');
    await writeAudit(tx, { actorType: auto ? 'system' : 'user', actorId: auto ? null : by.userId, action: auto ? 'timesheet.auto_approve' : 'timesheet.approve', targetType: 'timesheet', targetId: t.id, after: r ?? {}, ip });
    return { status: auto ? 'auto_approved' : 'approved', payoutPaise: r?.amount ?? 0 };
  });
}

/**
 * PAY-01: a business can dispute some minutes. Only the pay for those minutes is held; everything
 * else, including allowances, is released at once. A business disputing too often gets flagged.
 */
export async function disputeTimesheet(db: Db, t0: { id: string; businessId: string }, userId: string, input: { minutes: number; category: string; reason: string }, ip: string) {
  return withTx(db, async (tx) => {
    const s = (await tx.query('SELECT shift_id FROM timesheets WHERE id = $1 AND business_id = $2', [t0.id, t0.businessId])).rows[0];
    if (!s) throw notFound();
    await tx.query('SELECT 1 FROM shifts WHERE id = $1 FOR UPDATE', [s.shift_id]);
    const t = (await tx.query('SELECT * FROM timesheets WHERE id = $1 FOR UPDATE', [t0.id])).rows[0];
    if (t.status !== 'pending_approval') throw conflict('not_pending', 'Only timesheets waiting for approval can be disputed.');
    const pol = await getPolicies(tx, ['dispute.min_reason_chars', 'dispute.business_rate_flag_bp']);
    if (input.reason.trim().length < pol['dispute.min_reason_chars']) throw badRequest('reason_required', 'Explain what happened.');
    const total = t.payable_minutes + t.overtime_minutes;
    if (input.minutes < 1 || input.minutes > total) throw badRequest('bad_minutes', `You can dispute between 1 and ${total} minutes.`);
    const disputedPay = payForMinutes({ basePayPaise: Number(t.base_pay_paise), overtimePayPaise: Number(t.overtime_pay_paise), payableMinutes: t.payable_minutes, overtimeMinutes: t.overtime_minutes }, input.minutes);
    const undisputedPay = Number(t.base_pay_paise) + Number(t.overtime_pay_paise) - disputedPay;
    const status = input.minutes >= total ? 'disputed' : 'partially_disputed';
    await tx.query(
      `UPDATE timesheets SET status = $2, disputed_minutes = $3, disputed_paise = $4, dispute_category = $5, dispute_reason = $6, disputed_by = $7, disputed_at = now() WHERE id = $1`,
      [t.id, status, input.minutes, disputedPay, input.category, input.reason, userId],
    );
    const f = feesFor(t);
    const held = f.ofPay(disputedPay);
    const r = await release(tx, t, undisputedPay + Number(t.allowances_paise), Math.max(0, f.fee - held.fee), Math.max(0, f.gst - held.gst), `approve-undisputed:${t.id}`, 'wage');
    // Every dispute becomes a case with a timeline both sides can follow and add to.
    await openCase(tx, { kind: 'timesheet', bookingId: t.booking_id, timesheetId: t.id, openedBy: 'business', actorId: userId,
      summary: `Business disputes ${input.minutes} min (${input.category.replaceAll('_', ' ')}): ${input.reason}. ₹${(disputedPay / 100).toFixed(2)} held; the rest was paid.` });

    const rate = (await tx.query(
      `SELECT count(*) FILTER (WHERE disputed_at IS NOT NULL)::int AS d, count(*)::int AS n FROM (
         SELECT disputed_at FROM timesheets WHERE business_id = $1 AND status NOT IN ('awaiting_confirmation', 'pending_approval') ORDER BY created_at DESC LIMIT 20) x`,
      [t.business_id],
    )).rows[0];
    if (rate.n >= 5 && rate.d * 10_000 > rate.n * pol['dispute.business_rate_flag_bp']) {
      await raiseFlag(tx, 'business', t.business_id, 'high_dispute_rate', { disputed: rate.d, of: rate.n }, 50);
    }
    await writeAudit(tx, { actorType: 'user', actorId: userId, action: 'timesheet.dispute', targetType: 'timesheet', targetId: t.id, reason: input.reason, after: { minutes: input.minutes, heldPaise: disputedPay, released: r?.amount ?? 0 }, ip });
    return { status, heldPaise: disputedPay, releasedPaise: r?.amount ?? 0 };
  });
}

/**
 * Ops decide how many disputed minutes the worker is paid for. Above the threshold a second
 * person must confirm (D-011 dispute.second_approver_over_paise). Whatever isn't awarded goes
 * back to the business when the shift settles. Full dispute workflow (evidence, timelines) is Phase 4.
 */
export async function resolveDispute(db: Db, timesheetId: string, staff: { staffId: string; roles: string[] }, input: { awardMinutes: number; reason: string } | 'confirm', ip: string) {
  return withTx(db, async (tx) => {
    const s = (await tx.query('SELECT shift_id FROM timesheets WHERE id = $1', [timesheetId])).rows[0];
    if (!s) throw notFound();
    await tx.query('SELECT 1 FROM shifts WHERE id = $1 FOR UPDATE', [s.shift_id]);
    const t = (await tx.query('SELECT * FROM timesheets WHERE id = $1 FOR UPDATE', [timesheetId])).rows[0];
    if (!['disputed', 'partially_disputed'].includes(t.status)) throw conflict('not_disputed', 'Nothing to resolve.');
    const pol = await getPolicies(tx, ['dispute.second_approver_over_paise']);
    let minutes: number;
    let reason: string;
    if (input === 'confirm') {
      if (t.resolution_minutes == null) throw conflict('no_proposal', 'There is no proposed resolution to confirm.');
      if (t.resolved_by === staff.staffId) throw forbidden('A different person must confirm this resolution.');
      minutes = t.resolution_minutes;
      reason = t.resolution_reason;
    } else {
      if (input.awardMinutes < 0 || input.awardMinutes > t.disputed_minutes) throw badRequest('bad_minutes', `Award between 0 and ${t.disputed_minutes} minutes.`);
      minutes = input.awardMinutes;
      reason = input.reason;
      if (Number(t.disputed_paise) > pol['dispute.second_approver_over_paise']) {
        await tx.query(`UPDATE timesheets SET resolution_minutes = $2, resolution_reason = $3, resolved_by = $4 WHERE id = $1`, [t.id, minutes, reason, staff.staffId]);
        await writeAudit(tx, { actorType: 'staff', actorId: staff.staffId, actorRoles: staff.roles, action: 'timesheet.resolution_proposed', targetType: 'timesheet', targetId: t.id, reason, after: { awardMinutes: minutes }, ip });
        return { status: 'awaiting_second_approver' };
      }
    }
    const award = Math.min(Number(t.disputed_paise), payForMinutes({ basePayPaise: Number(t.base_pay_paise), overtimePayPaise: Number(t.overtime_pay_paise), payableMinutes: t.payable_minutes, overtimeMinutes: t.overtime_minutes }, minutes));
    await tx.query(
      `UPDATE timesheets SET status = 'resolved', resolution_minutes = $2, resolution_reason = $3, resolved_by = COALESCE(resolved_by, $4),
              resolution_approved_by = CASE WHEN resolved_by IS NOT NULL AND resolved_by <> $4 THEN $4 END, resolved_at = now() WHERE id = $1`,
      [t.id, minutes, reason, staff.staffId],
    );
    const kase = (await tx.query('SELECT id FROM dispute_cases WHERE timesheet_id = $1', [t.id])).rows[0];
    if (kase) {
      await tx.query(`UPDATE dispute_cases SET status = 'decided', decision = $2, decision_reason = $3, decided_by = $4, decided_at = now() WHERE id = $1`,
        [kase.id, `Worker paid for ${minutes} of ${t.disputed_minutes} disputed minutes`, reason, staff.staffId]);
      await caseEvent(tx, kase.id, 'ops', staff.staffId, 'decision', `Decision: the worker is paid for ${minutes} of the ${t.disputed_minutes} disputed minutes (₹${(award / 100).toFixed(2)}). Reason: ${reason}`);
    }
    if (award > 0) {
      const f = feesFor(t);
      const a = f.ofPay(award), held = f.ofPay(Number(t.disputed_paise));
      await release(tx, t, award, Math.min(a.fee, held.fee), Math.min(a.gst, held.gst), `dispute-award:${t.id}`, 'dispute_award');
    }
    await writeAudit(tx, { actorType: 'staff', actorId: staff.staffId, actorRoles: staff.roles, action: 'timesheet.resolved', targetType: 'timesheet', targetId: t.id, reason, after: { awardMinutes: minutes, awardPaise: award }, ip });
    return { status: 'resolved', awardPaise: award };
  });
}

/** PAY-02: the business doesn't answer in time → the hours are approved automatically. */
export async function autoApproveDue(db: Db): Promise<number> {
  const due = await db.query(`SELECT id, business_id FROM timesheets WHERE status = 'pending_approval' AND approval_deadline <= now() LIMIT 200`);
  let n = 0;
  for (const t of due.rows) {
    try { await approveTimesheet(db, { id: t.id, businessId: t.business_id }, 'auto'); n += 1; } catch { /* approved meanwhile */ }
  }
  return n;
}

// ------------------------------------------------------------------ payouts

const DESTINATION_SQL = `SELECT m.*, COALESCE(m.vpa_enc, m.account_no_enc) AS dest_enc FROM payout_methods m WHERE m.worker_id = $1 AND m.status = 'verified'`;

/** Claims due payouts (SKIP LOCKED, so two runners never take the same one) and pays them. */
export async function processPayouts(db: Db, provider: PayoutProvider, dataKey: string, sms?: SmsSender, opts: { afterProviderCall?: () => void } = {}): Promise<number> {
  // Release cooldown holds whose time has come, and recover payouts stuck in "processing" (crash recovery).
  await db.query(`UPDATE payouts SET status = 'queued', held_reason = NULL WHERE status = 'held' AND held_reason = 'payout_method_cooldown' AND next_attempt_at <= now()`);
  await db.query(`UPDATE payouts SET status = 'queued' WHERE status = 'processing' AND updated_at < now() - interval '5 minutes'`);

  const claimed = await withTx(db, async (tx) => (await tx.query(
    `UPDATE payouts SET status = 'processing', attempt_count = attempt_count + 1
      WHERE id IN (SELECT id FROM payouts WHERE status = 'queued' AND next_attempt_at <= now() ORDER BY next_attempt_at LIMIT 20 FOR UPDATE SKIP LOCKED)
      RETURNING *`,
  )).rows);
  let paid = 0;
  for (const p of claimed) {
    const pol = await getPolicies(db, ['payout.daily_cap_paise', 'payout.monthly_cap_paise', 'payout.max_attempts']);
    const hold = async (reason: string, nextAt?: Date) =>
      db.query(`UPDATE payouts SET status = 'held', held_reason = $2, next_attempt_at = COALESCE($3, next_attempt_at) WHERE id = $1`, [p.id, reason, nextAt ?? null]);

    const method = (await db.query(DESTINATION_SQL, [p.worker_id])).rows[0];
    if (!method) { await hold('no_payout_method'); continue; }
    // MON-04: right after a payout account change, money waits until the cooldown ends.
    if (method.cooldown_until && method.cooldown_until > new Date()) { await hold('payout_method_cooldown', method.cooldown_until); continue; }
    // MON-02: unusually large amounts to one person wait for finance.
    const sums = (await db.query(
      `SELECT COALESCE(sum(amount_paise) FILTER (WHERE (paid_at AT TIME ZONE 'Asia/Kolkata')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date), 0)::bigint AS day,
              COALESCE(sum(amount_paise) FILTER (WHERE date_trunc('month', paid_at AT TIME ZONE 'Asia/Kolkata') = date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata')), 0)::bigint AS month
         FROM payouts WHERE worker_id = $1 AND status = 'paid'`,
      [p.worker_id],
    )).rows[0];
    if (p.kind !== 'manual' && (sums.day + Number(p.amount_paise) > pol['payout.daily_cap_paise'] || sums.month + Number(p.amount_paise) > pol['payout.monthly_cap_paise'])) {
      await hold('cap_exceeded');
      await raiseFlag(db, 'worker', p.worker_id, 'payout_cap_exceeded', { payoutId: p.id, amount: p.amount_paise, today: sums.day, month: sums.month }, 60);
      continue;
    }

    const res = await provider.transfer({ idempotencyKey: p.idempotency_key, amountPaise: Number(p.amount_paise), destination: decrypt(method.dest_enc, dataKey) });
    opts.afterProviderCall?.(); // tests use this to simulate a crash right after the money moved
    if (res.ok) {
      await withTx(db, async (tx) => {
        const u = await tx.query(
          `UPDATE payouts SET status = 'paid', provider_ref = $2, paid_at = now(), payout_method_id = $3, held_reason = NULL, last_error = NULL
            WHERE id = $1 AND status = 'processing' RETURNING *`,
          [p.id, res.providerRef, method.id],
        );
        if (!u.rowCount) return;
        await postJournal(tx, { kind: 'payout', refType: 'payout', refId: p.id, idempotencyKey: `paid:${p.id}` }, [
          { account: workerPayable(p.worker_id), type: 'worker_payable', ownerId: p.worker_id, amountPaise: -Number(p.amount_paise) },
          { account: clearingAccount(PROVIDER), type: 'provider_clearing', amountPaise: Number(p.amount_paise) },
        ], { nonNegative: [workerPayable(p.worker_id)] });
        await createPayslip(tx, u.rows[0], method.display);
      });
      paid += 1;
      await notify(db, { dataKey }, { userId: p.worker_id, template: 'payout_sent', vars: { paise: Number(p.amount_paise), to: method.display }, dedupeKey: `paid:${p.id}` });
    } else if (res.retryable && p.attempt_count < pol['payout.max_attempts']) {
      await db.query(`UPDATE payouts SET status = 'queued', last_error = $2, next_attempt_at = now() + make_interval(mins => $3) WHERE id = $1`, [p.id, res.reason, 2 ** p.attempt_count]);
    } else {
      await db.query(`UPDATE payouts SET status = 'held', held_reason = $2, last_error = $2 WHERE id = $1`, [p.id, res.retryable ? 'retries_exhausted' : res.reason]);
      await raiseFlag(db, 'worker', p.worker_id, 'payout_failed', { payoutId: p.id, reason: res.reason }, 30);
      await notify(db, { dataKey }, { userId: p.worker_id, template: 'payout_held', dedupeKey: `held:${p.id}:${p.attempt_count}` });
    }
  }
  return paid;
}

/** A worker added a working account: retry their payouts that were waiting for one. */
export async function releaseHeldForWorker(db: Db | Tx, workerId: string) {
  await db.query(
    `UPDATE payouts SET status = 'queued', next_attempt_at = now(), held_reason = NULL
      WHERE worker_id = $1 AND status = 'held' AND held_reason IN ('no_payout_method', 'beneficiary_account_closed', 'returned_by_bank')`,
    [workerId],
  );
}

async function nextNumber(tx: Tx, series: string): Promise<string> {
  const r = await tx.query(
    `INSERT INTO doc_counters (series, last_no) VALUES ($1, 1) ON CONFLICT (series) DO UPDATE SET last_no = doc_counters.last_no + 1 RETURNING last_no`,
    [series],
  );
  return `${series}/${String(r.rows[0].last_no).padStart(6, '0')}`;
}

async function createPayslip(tx: Tx, p: Record<string, any>, destination: string) {
  const t = p.timesheet_id ? (await tx.query(
    `SELECT t.*, s.title, s.pay_type, s.pay_paise, s.meal_allowance_paise, s.travel_allowance_paise, s.starts_at, COALESCE(b.trade_name, b.legal_name) AS business
       FROM timesheets t JOIN shifts s ON s.id = t.shift_id JOIN businesses b ON b.id = t.business_id WHERE t.id = $1`,
    [p.timesheet_id],
  )).rows[0] : null;
  const lines: { label: string; detail?: string; paise: number }[] = [];
  if (t && p.kind === 'wage') {
    const held = Number(t.disputed_paise ?? 0);
    lines.push({ label: 'Base pay', detail: `${(t.payable_minutes / 60).toFixed(2)} h × ₹${(Number(t.pay_paise) / 100).toFixed(2)}${t.pay_type === 'hourly' ? '/h' : ' per shift (pro-rated)'}`, paise: Number(t.base_pay_paise) });
    if (Number(t.overtime_pay_paise)) lines.push({ label: 'Overtime', detail: `${(t.overtime_minutes / 60).toFixed(2)} h`, paise: Number(t.overtime_pay_paise) });
    if (Number(t.meal_allowance_paise)) lines.push({ label: 'Meal allowance', paise: Number(t.meal_allowance_paise) });
    if (Number(t.travel_allowance_paise)) lines.push({ label: 'Travel allowance', paise: Number(t.travel_allowance_paise) });
    if (held) lines.push({ label: 'Held: disputed by business', detail: `${t.disputed_minutes} min, decided separately`, paise: -held });
  } else {
    lines.push({ label: p.kind === 'dispute_award' ? 'Dispute decided in your favour' : 'Payment from ShiftKart', detail: p.reason ?? undefined, paise: Number(p.amount_paise) });
  }
  const gross = lines.filter((l) => l.paise > 0).reduce((a, l) => a + l.paise, 0);
  const deductions = 0; // TDS / welfare deductions: configurable once confirmed (LEGAL L-02, L-03, L-13)
  const net = Number(p.amount_paise);
  await tx.query(
    `INSERT INTO payslips (number, worker_id, payout_id, timesheet_id, lines, gross_paise, deductions_paise, net_paise) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [await nextNumber(tx, `PS/${istDate(new Date()).slice(0, 7)}`), p.worker_id, p.id, p.timesheet_id,
     JSON.stringify({ shift: t ? { title: t.title, business: t.business, date: t.starts_at } : null, lines, paidTo: destination, noFeesNotice: 'ShiftKart never charges workers.' }),
     gross, deductions, net],
  );
}

// ------------------------------------------------------------------ settlement

/**
 * Closes finished shifts: marks no-shows, refunds whatever is left in the shift's escrow to the
 * card/account it came from (MON-02), and issues the GST invoice for our fee. Runs only when every
 * timesheet on the shift is final, so a refund can never overtake a payout (SYS-05).
 */
export async function settleShifts(db: Db, provider: PayoutProvider): Promise<number> {
  const pol = await getPolicies(db, ['settlement.no_show_after_min']);
  const due = await db.query(
    `SELECT id FROM shifts WHERE settled_at IS NULL AND (
        (status = 'live' AND ends_at + make_interval(mins => $1) <= now()) OR status = 'cancelled' AND published_at IS NOT NULL)
      LIMIT 50`,
    [pol['settlement.no_show_after_min']],
  );
  let n = 0;
  for (const { id } of due.rows) if (await settleShift(db, provider, id)) n += 1;
  return n;
}

export async function settleShift(db: Db, provider: PayoutProvider, shiftId: string): Promise<boolean> {
  return withTx(db, async (tx) => {
    const s = (await tx.query('SELECT * FROM shifts WHERE id = $1 FOR UPDATE', [shiftId])).rows[0];
    if (!s || s.settled_at || !['live', 'cancelled'].includes(s.status)) return false;
    if (s.status === 'live') {
      // Never checked in, never cancelled: a no-show, with a strike (appealable).
      const noShows = (await tx.query(`UPDATE bookings SET status = 'no_show' WHERE shift_id = $1 AND status = 'confirmed' RETURNING id, worker_id`, [shiftId])).rows;
      for (const n of noShows) await recordStrike(tx, n.worker_id, n.id, 'no_show', null);
    }
    const open = await tx.query(
      `SELECT (SELECT count(*) FROM bookings WHERE shift_id = $1 AND status = 'checked_in')
            + (SELECT count(*) FROM timesheets WHERE shift_id = $1 AND status IN ('awaiting_confirmation', 'pending_approval', 'partially_disputed', 'disputed'))
            + (SELECT count(*) FROM overtime_requests WHERE shift_id = $1 AND status IN ('awaiting_funding', 'awaiting_worker')) AS n`,
      [shiftId],
    );
    if (Number(open.rows[0].n) > 0) return false;

    let remaining = await accountBalance(tx, shiftEscrow(shiftId));
    const intents = (await tx.query(
      `SELECT * FROM payment_intents WHERE shift_id = $1 AND status = 'captured' AND chargeback_at IS NULL ORDER BY purpose DESC, captured_at DESC`,
      [shiftId],
    )).rows;
    for (const i of intents) {
      if (remaining <= 0) break;
      const amount = Math.min(remaining, Number(i.amount_paise) - Number(i.refunded_paise));
      if (amount <= 0) continue;
      const key = `refund:${i.id}:${shiftId}`;
      const res = await provider.refund({ idempotencyKey: key, orderRef: i.provider_ref, amountPaise: amount });
      if (!res.ok) throw new Error(`refund failed: ${res.reason}`);
      const r = (await tx.query(
        `INSERT INTO refunds (payment_intent_id, shift_id, amount_paise, idempotency_key, provider_ref, status, reason)
         VALUES ($1, $2, $3, $4, $5, 'processed', 'Unused shift funds') ON CONFLICT (idempotency_key) DO UPDATE SET status = 'processed' RETURNING id`,
        [i.id, shiftId, amount, key, res.providerRef],
      )).rows[0];
      await postJournal(tx, { kind: 'refund', refType: 'refund', refId: r.id, idempotencyKey: key }, [
        { account: shiftEscrow(shiftId), type: 'shift_escrow', ownerId: s.business_id, amountPaise: -amount },
        { account: clearingAccount(PROVIDER), type: 'provider_clearing', amountPaise: amount },
      ], { nonNegative: [shiftEscrow(shiftId)] });
      await tx.query('UPDATE payment_intents SET refunded_paise = refunded_paise + $2 WHERE id = $1', [i.id, amount]);
      remaining -= amount;
    }

    const fee = (await tx.query(
      `SELECT COALESCE(sum(e.amount_paise) FILTER (WHERE a.code = $2), 0)::bigint AS fee
         FROM journals j JOIN ledger_entries e ON e.journal_id = j.id JOIN ledger_accounts a ON a.id = e.account_id
        WHERE j.ref_type = 'shift' AND j.ref_id = $1`,
      [shiftId, PLATFORM_REVENUE],
    )).rows[0].fee as number;
    if (fee > 0) {
      const b = (await tx.query('SELECT legal_name, gstin FROM businesses WHERE id = $1', [s.business_id])).rows[0];
      const buyerState = b.gstin ? (b.gstin.slice(0, 2) === '29' ? 'KA' : `GST-${b.gstin.slice(0, 2)}`) : null;
      const split = gstSplit(fee, s.cost.gstBp, SELLER.stateCode, buyerState);
      await tx.query(
        `INSERT INTO invoices (number, business_id, shift_id, buyer, seller, lines, taxable_paise, cgst_paise, sgst_paise, igst_paise, total_paise)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [await nextNumber(tx, `INV/${financialYear(new Date())}`), s.business_id, shiftId,
         JSON.stringify({ legalName: b.legal_name, gstin: b.gstin, stateCode: buyerState }), JSON.stringify(SELLER),
         JSON.stringify([{ description: `Platform fee: "${s.title}" on ${istDate(s.starts_at)}`, sac: SELLER.sac, taxablePaise: fee }]),
         fee, split.cgst, split.sgst, split.igst, fee + split.total],
      );
    }
    await tx.query(`UPDATE shifts SET status = CASE WHEN status = 'live' THEN 'completed' ELSE status END, settled_at = now() WHERE id = $1`, [shiftId]);
    await velocityCheck(tx, s);
    await writeAudit(tx, { actorType: 'system', action: 'shift.settled', targetType: 'shift', targetId: shiftId, after: { refunded: (await accountBalance(tx, shiftEscrow(shiftId))) === 0, feePaise: fee } });
    return true;
  });
}

// ------------------------------------------------------------------ chargebacks, reversals

/**
 * PAY-09: a business reverses its payment after workers were paid. Workers keep their money; we
 * take the loss, suspend the business and pursue recovery.
 */
export async function handleChargeback(tx: Tx, orderRef: string, amountPaise: number) {
  const i = (await tx.query('SELECT * FROM payment_intents WHERE provider_ref = $1 FOR UPDATE', [orderRef])).rows[0];
  if (!i || i.chargeback_at) return 'ignored';
  await tx.query('UPDATE payment_intents SET chargeback_at = now() WHERE id = $1', [i.id]);
  const held = Math.max(0, await accountBalance(tx, shiftEscrow(i.shift_id)));
  const fromEscrow = Math.min(held, amountPaise);
  await postJournal(tx, { kind: 'chargeback', refType: 'payment_intent', refId: i.id, idempotencyKey: `chargeback:${i.id}` }, [
    { account: clearingAccount(PROVIDER), type: 'provider_clearing', amountPaise },
    ...(fromEscrow ? [{ account: shiftEscrow(i.shift_id), type: 'shift_escrow', ownerId: i.business_id, amountPaise: -fromEscrow }] : []),
    ...(amountPaise - fromEscrow ? [{ account: CHARGEBACK_LOSS, type: 'loss', amountPaise: -(amountPaise - fromEscrow) }] : []),
  ]);
  await tx.query(`UPDATE businesses SET verification_status = 'suspended', decision_reason = 'Payment reversed (chargeback)' WHERE id = $1`, [i.business_id]);
  await raiseFlag(tx, 'business', i.business_id, 'chargeback', { intentId: i.id, amount: amountPaise, lossPaise: amountPaise - fromEscrow }, 90);
  await writeAudit(tx, { actorType: 'system', action: 'payment.chargeback', targetType: 'business', targetId: i.business_id, after: { amountPaise, fromEscrow } });
  return 'chargeback_booked';
}

/** The bank returned a payout (e.g. account closed). The money is owed again; the worker fixes their account. */
export async function handlePayoutReversal(tx: Tx, providerRef: string) {
  const p = (await tx.query(`SELECT * FROM payouts WHERE provider_ref = $1 FOR UPDATE`, [providerRef])).rows[0];
  if (!p || p.status !== 'paid') return 'ignored';
  await tx.query(`UPDATE payouts SET status = 'reversed' WHERE id = $1`, [p.id]);
  await postJournal(tx, { kind: 'reversal', refType: 'payout', refId: p.id, idempotencyKey: `reversed:${p.id}` }, [
    { account: workerPayable(p.worker_id), type: 'worker_payable', ownerId: p.worker_id, amountPaise: Number(p.amount_paise) },
    { account: clearingAccount(PROVIDER), type: 'provider_clearing', amountPaise: -Number(p.amount_paise) },
  ]);
  await tx.query(
    `INSERT INTO payouts (worker_id, timesheet_id, kind, amount_paise, status, held_reason, idempotency_key, journal_key)
     VALUES ($1, $2, $3, $4, 'held', 'returned_by_bank', $5, $6)`,
    [p.worker_id, p.timesheet_id, p.kind, p.amount_paise, `${p.idempotency_key}:after-reversal`, p.journal_key],
  );
  await tx.query(`UPDATE payout_methods SET status = 'rejected' WHERE id = $1`, [p.payout_method_id]);
  return 'reversal_booked';
}

// ------------------------------------------------------------------ manual payouts (INT-03)

export async function requestManualPayout(db: Db, staff: { staffId: string; roles: string[] }, input: { workerId: string; amountPaise: number; reason: string }, ip: string) {
  return withTx(db, async (tx) => {
    const m = (await tx.query(`SELECT 1 FROM payout_methods WHERE worker_id = $1 AND status = 'verified'`, [input.workerId])).rows[0];
    if (!m) throw conflict('no_verified_account', 'Manual payouts only go to a worker\'s own verified account.');
    const pol = await getPolicies(tx, ['payout.manual_daily_cap_paise']);
    const today = (await tx.query(
      `SELECT COALESCE(sum(amount_paise), 0)::bigint AS s FROM payouts WHERE kind = 'manual' AND status NOT IN ('rejected') AND created_at > date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata'`,
    )).rows[0].s;
    if (today + input.amountPaise > pol['payout.manual_daily_cap_paise']) throw conflict('manual_cap', 'Today\'s limit for manual payouts is reached.');
    const p = (await tx.query(
      `INSERT INTO payouts (worker_id, kind, amount_paise, status, idempotency_key, journal_key, requested_by, reason)
       VALUES ($1, 'manual', $2, 'pending_approval', 'manual:' || gen_random_uuid(), 'manual:' || gen_random_uuid(), $3, $4) RETURNING id`,
      [input.workerId, input.amountPaise, staff.staffId, input.reason],
    )).rows[0];
    await writeAudit(tx, { actorType: 'staff', actorId: staff.staffId, actorRoles: staff.roles, action: 'payout.manual_request', targetType: 'user', targetId: input.workerId, reason: input.reason, after: { amountPaise: input.amountPaise, payoutId: p.id }, ip });
    return { id: p.id as string, status: 'pending_approval' };
  });
}

export async function decideManualPayout(db: Db, staff: { staffId: string; roles: string[] }, payoutId: string, approve: boolean, reason: string, ip: string) {
  return withTx(db, async (tx) => {
    const p = (await tx.query(`SELECT * FROM payouts WHERE id = $1 AND kind = 'manual' FOR UPDATE`, [payoutId])).rows[0];
    if (!p || p.status !== 'pending_approval') throw conflict('not_pending', 'Not waiting for approval.');
    if (p.requested_by === staff.staffId) throw forbidden('A different finance officer must approve this payout.');
    if (approve) {
      await postJournal(tx, { kind: 'adjustment', refType: 'payout', refId: p.id, idempotencyKey: p.journal_key, memo: p.reason, createdBy: staff.staffId }, [
        { account: PLATFORM_ADJUSTMENTS, type: 'adjustment', amountPaise: -Number(p.amount_paise) },
        { account: workerPayable(p.worker_id), type: 'worker_payable', ownerId: p.worker_id, amountPaise: Number(p.amount_paise) },
      ]);
    }
    await tx.query(`UPDATE payouts SET status = $2, approved_by = $3, approved_at = now() WHERE id = $1`, [payoutId, approve ? 'queued' : 'rejected', staff.staffId]);
    await writeAudit(tx, { actorType: 'staff', actorId: staff.staffId, actorRoles: staff.roles, action: approve ? 'payout.manual_approve' : 'payout.manual_reject', targetType: 'payout', targetId: payoutId, reason, ip });
    return { status: approve ? 'queued' : 'rejected' };
  });
}

// ------------------------------------------------------------------ reconciliation (SYS-06)

/**
 * Daily: does the provider's record of money in and out match our ledger's provider-clearing
 * account for the same IST day? Any difference opens a finance flag.
 */
export async function reconcile(db: Db, date: string, staffId?: string) {
  const provider = (await db.query(
    `SELECT COALESCE(sum(CASE kind WHEN 'capture' THEN amount_paise WHEN 'payout_reversal' THEN amount_paise ELSE -amount_paise END), 0)::bigint AS net,
            count(*)::int AS n
       FROM mock_provider_ledger WHERE status = 'success' AND (at AT TIME ZONE 'Asia/Kolkata')::date = $1::date`,
    [date],
  )).rows[0];
  const ledger = (await db.query(
    `SELECT COALESCE(-sum(e.amount_paise), 0)::bigint AS net, count(*)::int AS n
       FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
      WHERE a.code = $2 AND (e.created_at AT TIME ZONE 'Asia/Kolkata')::date = $1::date`,
    [date, clearingAccount(PROVIDER)],
  )).rows[0];
  const diff = provider.net - ledger.net;
  const status = diff === 0 ? 'matched' : 'mismatch';
  const r = (await db.query(
    `INSERT INTO reconciliation_runs (run_date, provider_net_paise, ledger_net_paise, diff_paise, status, details, run_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [date, provider.net, ledger.net, diff, status, JSON.stringify({ providerEntries: provider.n, ledgerEntries: ledger.n }), staffId ?? null],
  )).rows[0];
  if (status === 'mismatch') await raiseFlag(db, 'system', `reconciliation:${date}`, 'reconciliation_mismatch', { runId: r.id, diff }, 95);
  return { id: r.id as string, date, providerNetPaise: provider.net, ledgerNetPaise: ledger.net, diffPaise: diff, status };
}
