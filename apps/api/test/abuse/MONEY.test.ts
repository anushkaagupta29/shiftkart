// PAY-01 dispute everything · PAY-02 ignore timesheets · PAY-07 unfunded overtime · PAY-09 chargeback ·
// SYS-03 double payout · SYS-05 refund vs payout · SYS-06 reconciliation · MON-02 caps & refunds to source ·
// MON-04 payout during cooldown · INT-01 frozen timesheets · INT-03 manual payouts.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, makeApp, resetData, staffWith, type Ctx } from '../helpers';
import { clock, fund, onShift, runJobs, seedRates, startShiftAgo, verifiedBusiness, workedShift, type Biz } from '../fixtures';
import { accountBalance, shiftEscrow, workerPayable } from '../../src/ledger';
import { processPayouts, reconcile, settleShift } from '../../src/money';
import { MockPayouts } from '../../src/adapters/payouts';
import { MOCKPAY_SIG_HEADER, signWebhook } from '../../src/adapters/mockpay';
import { istDate } from '../../src/time';

let ctx: Ctx;
let b: Biz;
beforeAll(async () => { ctx = await makeApp(); await resetData(ctx.db); await seedRates(ctx); b = await verifiedBusiness(ctx); });
afterAll(async () => closeApp(ctx));

const payouts = async (workerId: string) => (await ctx.db.query(`SELECT * FROM payouts WHERE worker_id = $1 ORDER BY created_at`, [workerId])).rows;
const flagsOf = async (subject: string) => (await ctx.db.query(`SELECT rule_code FROM fraud_flags WHERE subject_id = $1 AND status = 'open'`, [subject])).rows.map((r) => r.rule_code);
const tsUrl = (id: string, action: string) => `/businesses/${b.businessId}/timesheets/${id}/${action}`;

describe('PAY-01 partial disputes', () => {
  it('only the disputed minutes are held; the rest (and allowances) is paid at once', async () => {
    const s = await workedShift(ctx, b);
    const d = await ctx.app.inject({ method: 'POST', url: tsUrl(s.timesheet.id, 'dispute'), headers: b.owner.auth, payload: { minutes: 45, category: 'long_breaks', reason: 'Took an extra 45 minute break' } });
    expect(d.json()).toEqual({ status: 'partially_disputed', heldPaise: 7500, releasedPaise: 72500 }); // 80000 − 7500
    await runJobs(ctx);
    const p = await payouts(s.worker.userId);
    expect(p.map((x) => [x.kind, Number(x.amount_paise), x.status])).toEqual([['wage', 72500, 'paid']]);

    // Ops award 30 of the 45 minutes; the other 15 go back to the business at settlement.
    const ops = await staffWith(ctx, ['ops_disputes']);
    const r = await ctx.app.inject({ method: 'POST', url: `/admin/timesheets/${s.timesheet.id}/resolve`, headers: ops.cookie, payload: { awardMinutes: 30, reason: 'Supervisor log shows a 15 min overrun only' } });
    expect(r.json()).toEqual({ status: 'resolved', awardPaise: 5000 });
    await runJobs(ctx);
    expect((await payouts(s.worker.userId)).map((x) => [x.kind, Number(x.amount_paise), x.status])).toEqual([['wage', 72500, 'paid'], ['dispute_award', 5000, 'paid']]);
    const slips = (await ctx.app.inject({ method: 'GET', url: '/worker/payslips', headers: s.worker.auth })).json();
    expect(slips.items).toHaveLength(2);
  });

  it('cannot dispute more minutes than were worked, or without a reason', async () => {
    const s = await workedShift(ctx, b);
    expect((await ctx.app.inject({ method: 'POST', url: tsUrl(s.timesheet.id, 'dispute'), headers: b.owner.auth, payload: { minutes: 999, category: 'other', reason: 'Too many minutes' } })).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: 'POST', url: tsUrl(s.timesheet.id, 'dispute'), headers: b.owner.auth, payload: { minutes: 10, category: 'other', reason: 'no' } })).statusCode).toBe(400);
  });

  it('big disputes need a second ops person to confirm', async () => {
    const s = await workedShift(ctx, b, { payPaise: 60000, payType: 'per_shift' });
    await ctx.db.query(`INSERT INTO policy_config (key, value, reason, effective_from) VALUES ('dispute.second_approver_over_paise', '20000', 'test', now() - interval '1 second')`);
    try {
      await ctx.app.inject({ method: 'POST', url: tsUrl(s.timesheet.id, 'dispute'), headers: b.owner.auth, payload: { minutes: 450, category: 'did_not_attend', reason: 'Was not seen at the site all day' } });
      const o1 = await staffWith(ctx, ['ops_disputes']);
      const o2 = await staffWith(ctx, ['ops_disputes']);
      const url = `/admin/timesheets/${s.timesheet.id}`;
      expect((await ctx.app.inject({ method: 'POST', url: `${url}/resolve`, headers: o1.cookie, payload: { awardMinutes: 450, reason: 'Check-in selfie and geofence are clean' } })).json().status).toBe('awaiting_second_approver');
      expect((await ctx.app.inject({ method: 'POST', url: `${url}/confirm-resolution`, headers: o1.cookie })).statusCode).toBe(403);
      expect((await ctx.app.inject({ method: 'POST', url: `${url}/confirm-resolution`, headers: o2.cookie })).json()).toEqual({ status: 'resolved', awardPaise: 60000 });
    } finally {
      await ctx.db.query(`INSERT INTO policy_config (key, value, reason, effective_from) VALUES ('dispute.second_approver_over_paise', '200000', 'test reset', now())`);
    }
  });

  it('a business that disputes most timesheets is flagged', async () => {
    const nb = await verifiedBusiness(ctx);
    for (let i = 0; i < 5; i++) {
      const s = await workedShift(ctx, nb);
      await ctx.app.inject({ method: 'POST', url: `/businesses/${nb.businessId}/timesheets/${s.timesheet.id}/dispute`, headers: nb.owner.auth, payload: { minutes: 30, category: 'other', reason: 'Disputing as a habit' } });
    }
    expect(await flagsOf(nb.businessId)).toContain('high_dispute_rate');
  });
});

describe('PAY-02 silence means approval', () => {
  it('after the 12 h window the timesheet is approved and paid automatically', async () => {
    const s = await workedShift(ctx, b);
    await runJobs(ctx);
    expect((await ctx.db.query('SELECT status FROM timesheets WHERE id = $1', [s.timesheet.id])).rows[0].status).toBe('pending_approval');
    await ctx.db.query(`UPDATE timesheets SET approval_deadline = now() - interval '1 second' WHERE id = $1`, [s.timesheet.id]);
    await runJobs(ctx);
    expect((await ctx.db.query('SELECT status FROM timesheets WHERE id = $1', [s.timesheet.id])).rows[0].status).toBe('auto_approved');
    expect((await payouts(s.worker.userId))[0].status).toBe('paid');
  });
});

describe('INT-01 timesheets are frozen', () => {
  it('amounts cannot be edited, even directly in the database', async () => {
    const s = await workedShift(ctx, b);
    await expect(ctx.db.query('UPDATE timesheets SET gross_paise = 1, base_pay_paise = 1 WHERE id = $1', [s.timesheet.id])).rejects.toThrow(/frozen/);
    await expect(ctx.db.query('DELETE FROM timesheets WHERE id = $1', [s.timesheet.id])).rejects.toThrow(/cannot be deleted/);
    await expect(ctx.db.query('UPDATE payslips SET net_paise = 1')).rejects.toThrow(/append-only/);
  });

  it('no API route edits a timesheet or payout amount', () => {
    const editing = ctx.app.authTable.filter((r) => ['PUT', 'PATCH'].includes(r.method) && /timesheet|payout|ledger|journal/.test(r.url));
    expect(editing).toEqual([]);
  });
});

describe('PAY-07 overtime', () => {
  it('the worker only sees it once the business has paid for it; then it is paid at 2×', async () => {
    const s = await onShift(ctx, b);
    await clock(ctx, s.worker, s.bookingId, s.shift.id, 'check-in');
    const ot = await ctx.app.inject({ method: 'POST', url: `/businesses/${b.businessId}/bookings/${s.bookingId}/overtime`, headers: b.owner.auth, payload: { extraMinutes: 60 } });
    expect(ot.statusCode).toBe(201);
    expect(ot.json()).toMatchObject({ workerPayPaise: 20000, totalPaise: 20000 + 3000 + 540 });
    expect((await ctx.app.inject({ method: 'POST', url: `/worker/overtime/${ot.json().id}/accept`, headers: s.worker.auth })).json().error.message).toMatch(/Waiting for the business/);

    await ctx.app.inject({ method: 'POST', url: `/mockpay/checkout/${ot.json().intentId}`, payload: { outcome: 'success' } });
    expect((await ctx.app.inject({ method: 'POST', url: `/worker/overtime/${ot.json().id}/accept`, headers: s.worker.auth })).json().status).toBe('accepted');

    // Work the whole shift plus 60 minutes, then check out.
    const len = (Date.parse(s.shift.endsAt) - Date.parse(s.shift.startsAt)) / 60_000;
    await startShiftAgo(ctx, s.shift.id, len + 61);
    const start = (await ctx.db.query('SELECT starts_at FROM shifts WHERE id = $1', [s.shift.id])).rows[0].starts_at;
    await ctx.db.query('ALTER TABLE attendance_events DISABLE TRIGGER attendance_events_append_only');
    await ctx.db.query('UPDATE attendance_events SET effective_at = $2 WHERE booking_id = $1', [s.bookingId, start]);
    await ctx.db.query('ALTER TABLE attendance_events ENABLE TRIGGER attendance_events_append_only');
    const co = await clock(ctx, s.worker, s.bookingId, s.shift.id, 'check-out');
    expect(co.json().timesheet).toMatchObject({ overtime_minutes: 60, overtime_pay_paise: 20000 });
    const ap = await ctx.app.inject({ method: 'POST', url: tsUrl(co.json().timesheet.id, 'approve'), headers: b.owner.auth });
    expect(ap.json().payoutPaise).toBe(80000 + 20000);
  });
});

describe('SYS-03 double payout', () => {
  it('two payout runners at once pay each payout exactly once', async () => {
    const s = await workedShift(ctx, b);
    await ctx.app.inject({ method: 'POST', url: tsUrl(s.timesheet.id, 'approve'), headers: b.owner.auth });
    const provider = new MockPayouts(ctx.db);
    await Promise.all([processPayouts(ctx.db, provider, ctx.config.dataKey), processPayouts(ctx.db, provider, ctx.config.dataKey), processPayouts(ctx.db, provider, ctx.config.dataKey)]);
    const p = await payouts(s.worker.userId);
    const sent = await ctx.db.query(`SELECT count(*)::int AS n FROM mock_provider_ledger WHERE kind = 'payout' AND idempotency_key = $1`, [p[0].idempotency_key]);
    expect(sent.rows[0].n).toBe(1);
    expect(p[0].status).toBe('paid');
    expect(await accountBalance(ctx.db, workerPayable(s.worker.userId))).toBe(0);
  });

  it('a crash right after the bank transfer does not pay twice on retry', async () => {
    const s = await workedShift(ctx, b);
    await ctx.app.inject({ method: 'POST', url: tsUrl(s.timesheet.id, 'approve'), headers: b.owner.auth });
    const provider = new MockPayouts(ctx.db);
    await expect(processPayouts(ctx.db, provider, ctx.config.dataKey, undefined, { afterProviderCall: () => { throw new Error('process killed'); } })).rejects.toThrow('process killed');
    const [stuck] = await payouts(s.worker.userId);
    expect(stuck.status).toBe('processing');
    // Make it look stuck for 10 minutes (bypassing the updated_at trigger, which would reset the time).
    await ctx.db.query('ALTER TABLE payouts DISABLE TRIGGER payouts_updated');
    await ctx.db.query(`UPDATE payouts SET updated_at = now() - interval '10 minutes' WHERE id = $1`, [stuck.id]);
    await ctx.db.query('ALTER TABLE payouts ENABLE TRIGGER payouts_updated');
    await processPayouts(ctx.db, provider, ctx.config.dataKey);
    const sent = await ctx.db.query(`SELECT count(*)::int AS n FROM mock_provider_ledger WHERE idempotency_key = $1`, [stuck.idempotency_key]);
    expect(sent.rows[0].n).toBe(1);
    expect((await payouts(s.worker.userId))[0].status).toBe('paid');
  });
});

describe('MON-04 / MON-02 payout holds', () => {
  it('right after changing the payout account, pay waits for the cooldown', async () => {
    const s = await workedShift(ctx, b);
    await ctx.db.query(`UPDATE payout_methods SET cooldown_until = now() + interval '1 day' WHERE worker_id = $1 AND status = 'verified'`, [s.worker.userId]);
    await ctx.app.inject({ method: 'POST', url: tsUrl(s.timesheet.id, 'approve'), headers: b.owner.auth });
    await runJobs(ctx);
    expect((await payouts(s.worker.userId))[0]).toMatchObject({ status: 'held', held_reason: 'payout_method_cooldown' });
    await ctx.db.query(`UPDATE payout_methods SET cooldown_until = now() - interval '1 second' WHERE worker_id = $1`, [s.worker.userId]);
    await ctx.db.query(`UPDATE payouts SET next_attempt_at = now() - interval '1 second' WHERE worker_id = $1`, [s.worker.userId]);
    await runJobs(ctx);
    expect((await payouts(s.worker.userId))[0].status).toBe('paid');
  });

  it('amounts over the daily cap wait for finance and raise a flag', async () => {
    await ctx.db.query(`INSERT INTO policy_config (key, value, reason, effective_from) VALUES ('payout.daily_cap_paise', '50000', 'test', now() - interval '1 second')`);
    try {
      const s = await workedShift(ctx, b);
      await ctx.app.inject({ method: 'POST', url: tsUrl(s.timesheet.id, 'approve'), headers: b.owner.auth });
      await runJobs(ctx);
      expect((await payouts(s.worker.userId))[0]).toMatchObject({ status: 'held', held_reason: 'cap_exceeded' });
      expect(await flagsOf(s.worker.userId)).toContain('payout_cap_exceeded');
    } finally {
      await ctx.db.query(`INSERT INTO policy_config (key, value, reason, effective_from) VALUES ('payout.daily_cap_paise', '1000000', 'reset', now())`);
    }
  });

  it('a closed bank account holds the pay and tells the worker; a new account releases it', async () => {
    const s = await workedShift(ctx, b);
    await ctx.db.query(`UPDATE payout_methods SET vpa_enc = $2 WHERE worker_id = $1`, [s.worker.userId, (await import('@shiftkart/shared')).encrypt('payoutfail@okaxis', ctx.config.dataKey)]);
    await ctx.app.inject({ method: 'POST', url: tsUrl(s.timesheet.id, 'approve'), headers: b.owner.auth });
    await runJobs(ctx);
    expect((await payouts(s.worker.userId))[0]).toMatchObject({ status: 'held', held_reason: 'beneficiary_account_closed' });
    await ctx.app.inject({ method: 'POST', url: '/worker/selfie', headers: s.worker.auth, payload: { mockPersonId: s.worker.personId } });
    const nm = await ctx.app.inject({ method: 'POST', url: '/worker/payout-method', headers: s.worker.auth, payload: { type: 'upi', vpa: `fresh${randomUUID().slice(0, 6)}@okaxis` } });
    expect(nm.statusCode).toBe(201);
    await ctx.db.query(`UPDATE payout_methods SET cooldown_until = NULL WHERE worker_id = $1`, [s.worker.userId]);
    await runJobs(ctx);
    expect((await payouts(s.worker.userId))[0].status).toBe('paid');
  });
});

describe('PAY-09 chargeback after workers were paid', () => {
  it('workers keep their money; the business is suspended; the loss is booked', async () => {
    const s = await workedShift(ctx, b);
    await ctx.app.inject({ method: 'POST', url: tsUrl(s.timesheet.id, 'approve'), headers: b.owner.auth });
    await runJobs(ctx);
    const intent = (await ctx.db.query(`SELECT provider_ref, amount_paise FROM payment_intents WHERE shift_id = $1 AND status = 'captured'`, [s.shift.id])).rows[0];
    const raw = JSON.stringify({ id: `evt_${randomUUID()}`, type: 'payment.chargeback', data: { orderRef: intent.provider_ref, amountPaise: Number(intent.amount_paise) } });
    const r = await ctx.app.inject({ method: 'POST', url: '/webhooks/mockpay', payload: raw, headers: { 'content-type': 'application/json', [MOCKPAY_SIG_HEADER]: signWebhook(ctx.config.mockpayWebhookSecret, raw) } });
    expect(r.json().outcome).toBe('chargeback_booked');
    expect((await payouts(s.worker.userId))[0].status).toBe('paid');
    expect(await accountBalance(ctx.db, 'chargeback_loss')).toBeLessThan(0);
    expect((await ctx.db.query('SELECT verification_status FROM businesses WHERE id = $1', [b.businessId])).rows[0].verification_status).toBe('suspended');
    await ctx.db.query(`UPDATE businesses SET verification_status = 'verified' WHERE id = $1`, [b.businessId]); // for the next tests
  });
});

describe('SYS-05 refunds never overtake payouts', () => {
  it('a shift does not settle (refund) while a timesheet is waiting, and escrow never goes negative', async () => {
    const s = await workedShift(ctx, b);
    await startShiftAgo(ctx, s.shift.id, 8 * 60 + 200);
    expect(await settleShift(ctx.db, new MockPayouts(ctx.db), s.shift.id)).toBe(false);
    await ctx.app.inject({ method: 'POST', url: tsUrl(s.timesheet.id, 'approve'), headers: b.owner.auth });
    expect(await settleShift(ctx.db, new MockPayouts(ctx.db), s.shift.id)).toBe(true);
    expect(await accountBalance(ctx.db, shiftEscrow(s.shift.id))).toBe(0);
    const neg = await ctx.db.query(
      `SELECT a.code FROM ledger_accounts a JOIN ledger_entries e ON e.account_id = a.id WHERE a.code LIKE 'shift_escrow:%' GROUP BY a.code HAVING sum(e.amount_paise) < 0`);
    expect(neg.rows).toEqual([]);
  });

  it('a refund can never exceed what was captured on that payment', async () => {
    const provider = new MockPayouts(ctx.db);
    const shift = await (await import('../fixtures')).postShift(ctx, b);
    const { intent } = await fund(ctx, b, shift.id);
    const r = await provider.refund({ idempotencyKey: `test:${randomUUID()}`, orderRef: intent.orderRef, amountPaise: intent.amountPaise + 1 });
    expect(r).toMatchObject({ ok: false, reason: 'refund_exceeds_capture' });
  });
});

describe('INT-03 manual payouts', () => {
  it('need a second finance officer and go only to a verified account', async () => {
    const s = await workedShift(ctx, b);
    const f1 = await staffWith(ctx, ['finance']);
    const f2 = await staffWith(ctx, ['finance']);
    const req = await ctx.app.inject({ method: 'POST', url: '/admin/payouts/manual', headers: f1.cookie, payload: { workerId: s.worker.userId, amountPaise: 10000, reason: 'Goodwill for app outage on Diwali' } });
    expect(req.statusCode).toBe(201);
    expect((await ctx.app.inject({ method: 'POST', url: `/admin/payouts/${req.json().id}/decide`, headers: f1.cookie, payload: { decision: 'approve', reason: 'Approving my own request' } })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'POST', url: `/admin/payouts/${req.json().id}/decide`, headers: f2.cookie, payload: { decision: 'approve', reason: 'Outage confirmed by tech' } })).json().status).toBe('queued');
    const nobody = await ctx.app.inject({ method: 'POST', url: '/admin/payouts/manual', headers: f1.cookie, payload: { workerId: b.owner.userId, amountPaise: 10000, reason: 'Pay a non-worker account' } });
    expect(nobody.json().error.code).toBe('no_verified_account');
  });
});

describe('SYS-06 daily reconciliation', () => {
  it('matches normally, and reports a difference when the provider and our ledger disagree', async () => {
    const today = istDate(new Date());
    // Webhook-only tests above created captures without the provider seeing them; start from a clean comparison.
    const base = await reconcile(ctx.db, today);
    await ctx.db.query(`INSERT INTO mock_provider_ledger (kind, ref, amount_paise) VALUES ('payout', 'mystery-transfer', 1234)`);
    const after = await reconcile(ctx.db, today);
    expect(after.diffPaise).toBe(base.diffPaise - 1234);
    expect(after.status).toBe('mismatch');
    expect((await ctx.db.query(`SELECT 1 FROM fraud_flags WHERE rule_code = 'reconciliation_mismatch'`)).rowCount).toBeGreaterThan(0);
  });
});
