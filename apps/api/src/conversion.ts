// OFF-01: hiring a worker full-time. Mostly handled by making the platform worth staying on;
// this is the honest route for a business that wants to hire someone permanently. The business
// pays a one-time fee; the worker is never charged, never bound, and can always say no.
import { applyBasisPoints, decrypt } from '@shiftkart/shared';
import type { Db } from './db';
import { withTx } from './db';
import { writeAudit } from './audit';
import { getPolicies } from './policy';
import { conflict, notFound } from './lib/errors';
import { newProviderRef } from './adapters/mockpay';
import { PLATFORM_REVENUE, GST_PAYABLE, clearingAccount, postJournal } from './ledger';
import { SELLER } from './money';
import { financialYear, gstSplit } from './domain/gst';
import type { Tx } from './db';
import type { SmsSender } from './adapters/sms';

export async function offerHire(db: Db, biz: { businessId: string; userId: string }, input: { bookingId: string; roleTitle: string; monthlySalaryPaise?: number; message?: string }, n: { sms: SmsSender; dataKey: string }) {
  return withTx(db, async (tx) => {
    const b = (await tx.query(`SELECT b.*, s.business_id FROM bookings b JOIN shifts s ON s.id = b.shift_id WHERE b.id = $1`, [input.bookingId])).rows[0];
    if (!b || b.business_id !== biz.businessId) throw notFound();
    if (b.status !== 'completed') throw conflict('not_worked', 'You can offer a job to someone who has completed a shift with you.');
    const pol = await getPolicies(tx, ['conversion.fee_paise', 'tax.gst_on_fee_bp']);
    let h;
    try {
      h = (await tx.query(
        `INSERT INTO hire_requests (business_id, worker_id, booking_id, role_title, monthly_salary_paise, message, fee_paise, gst_paise) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [biz.businessId, b.worker_id, input.bookingId, input.roleTitle, input.monthlySalaryPaise ?? null, input.message ?? '', pol['conversion.fee_paise'], applyBasisPoints(pol['conversion.fee_paise'], pol['tax.gst_on_fee_bp'])],
      )).rows[0];
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw conflict('already_offered', 'You already have an open offer to this person.');
      throw e;
    }
    const u = (await tx.query('SELECT phone_enc FROM users WHERE id = $1', [b.worker_id])).rows[0];
    await n.sms.send(decrypt(u.phone_enc, n.dataKey), `ShiftKart: a business you worked for is offering you a full-time job (${input.roleTitle}). See it in the app. You never pay anything, and you can say no.`);
    await writeAudit(tx, { actorType: 'user', actorId: biz.userId, action: 'hire.offer', targetType: 'user', targetId: b.worker_id, after: { roleTitle: input.roleTitle } });
    return { id: h.id as string, status: h.status as string, feePaise: Number(h.fee_paise), gstPaise: Number(h.gst_paise) };
  });
}

export async function respondHire(db: Db, workerId: string, id: string, accept: boolean) {
  const r = await db.query(
    `UPDATE hire_requests SET status = $3, worker_responded_at = now() WHERE id = $1 AND worker_id = $2 AND status = 'offered' RETURNING id`,
    [id, workerId, accept ? 'accepted' : 'declined'],
  );
  if (!r.rowCount) throw conflict('not_open', 'This offer is no longer open.');
  return { status: accept ? 'accepted' : 'declined' };
}

export async function payHireFee(db: Db, biz: { businessId: string; userId: string }, id: string) {
  return withTx(db, async (tx) => {
    const h = (await tx.query('SELECT * FROM hire_requests WHERE id = $1 AND business_id = $2 FOR UPDATE', [id, biz.businessId])).rows[0];
    if (!h) throw notFound();
    if (h.status !== 'accepted') throw conflict('not_accepted', h.status === 'paid' ? 'Already paid.' : 'The worker has not accepted yet.');
    if (h.payment_intent_id) return { intentId: h.payment_intent_id as string, checkoutPath: `/pay/${h.payment_intent_id}` };
    const i = (await tx.query(
      `INSERT INTO payment_intents (business_id, amount_paise, provider, provider_ref, idempotency_key, purpose, hire_request_id)
       VALUES ($1, $2, 'mockpay', $3, $4, 'conversion', $5) RETURNING id`,
      [biz.businessId, Number(h.fee_paise) + Number(h.gst_paise), newProviderRef(), `${biz.businessId}:hire:${id}`, id],
    )).rows[0];
    await tx.query('UPDATE hire_requests SET payment_intent_id = $2 WHERE id = $1', [id, i.id]);
    return { intentId: i.id as string, checkoutPath: `/pay/${i.id}` };
  });
}

/** Called from the payment webhook: book the fee, issue the invoice, unlock contact details. */
export async function hireFeePaid(tx: Tx, hireRequestId: string, intentId: string, providerRefPrefix = 'mockpay') {
  const h = (await tx.query(`UPDATE hire_requests SET status = 'paid', paid_at = now() WHERE id = $1 AND status = 'accepted' RETURNING *`, [hireRequestId])).rows[0];
  if (!h) return;
  await postJournal(tx, { kind: 'fee', refType: 'hire_request', refId: h.id, idempotencyKey: `hire:${h.id}` }, [
    { account: clearingAccount(providerRefPrefix), type: 'provider_clearing', amountPaise: -(Number(h.fee_paise) + Number(h.gst_paise)) },
    { account: PLATFORM_REVENUE, type: 'revenue', amountPaise: Number(h.fee_paise) },
    { account: GST_PAYABLE, type: 'tax', amountPaise: Number(h.gst_paise) },
  ]);
  const b = (await tx.query('SELECT legal_name, gstin FROM businesses WHERE id = $1', [h.business_id])).rows[0];
  const buyerState = b.gstin ? (b.gstin.slice(0, 2) === '29' ? 'KA' : `GST-${b.gstin.slice(0, 2)}`) : null;
  const split = gstSplit(Number(h.fee_paise), 1800, SELLER.stateCode, buyerState);
  const seq = (await tx.query(
    `INSERT INTO doc_counters (series, last_no) VALUES ($1, 1) ON CONFLICT (series) DO UPDATE SET last_no = doc_counters.last_no + 1 RETURNING last_no`,
    [`INV/${financialYear(new Date())}`],
  )).rows[0].last_no;
  await tx.query(
    `INSERT INTO invoices (number, business_id, hire_request_id, buyer, seller, lines, taxable_paise, cgst_paise, sgst_paise, igst_paise, total_paise)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [`INV/${financialYear(new Date())}/${String(seq).padStart(6, '0')}`, h.business_id, h.id, JSON.stringify({ legalName: b.legal_name, gstin: b.gstin, stateCode: buyerState }), JSON.stringify(SELLER),
     JSON.stringify([{ description: `Full-time hire fee: ${h.role_title}`, sac: SELLER.sac, taxablePaise: Number(h.fee_paise) }]),
     Number(h.fee_paise), split.cgst, split.sgst, split.igst, Number(h.fee_paise) + split.total],
  );
  void intentId;
}

export async function listHires(db: Db, who: { businessId?: string; workerId?: string }, dataKey: string) {
  const r = await db.query(
    `SELECT h.*, p.first_name, COALESCE(b.trade_name, b.legal_name) AS business, wu.phone_enc AS worker_phone, ou.phone_enc AS owner_phone
       FROM hire_requests h JOIN worker_profiles p ON p.user_id = h.worker_id JOIN businesses b ON b.id = h.business_id
       JOIN users wu ON wu.id = h.worker_id
       JOIN business_members om ON om.business_id = h.business_id AND om.role = 'owner' AND om.removed_at IS NULL JOIN users ou ON ou.id = om.user_id
      WHERE ${who.businessId ? 'h.business_id = $1' : 'h.worker_id = $1'} ORDER BY h.created_at DESC`,
    [who.businessId ?? who.workerId],
  );
  return r.rows.map((h) => ({
    id: h.id, status: h.status, roleTitle: h.role_title, monthlySalaryPaise: h.monthly_salary_paise ? Number(h.monthly_salary_paise) : null, message: h.message,
    feePaise: Number(h.fee_paise), gstPaise: Number(h.gst_paise), createdAt: h.created_at,
    ...(who.businessId ? { workerFirstName: h.first_name } : { business: h.business }),
    // Contact details are exchanged only once the worker has said yes and the fee is paid.
    contact: h.status === 'paid' ? decrypt(who.businessId ? h.worker_phone : h.owner_phone, dataKey) : null,
  }));
}
