// SYS-04 forged or replayed webhooks; PAY-10 funding that never completes; duplicate funding.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, makeApp, resetData, type Ctx } from '../helpers';
import { fund, postShift, seedRates, verifiedBusiness, type Biz } from '../fixtures';
import { MOCKPAY_SIG_HEADER, signWebhook } from '../../src/adapters/mockpay';
import { accountBalance, shiftEscrow } from '../../src/ledger';

let ctx: Ctx;
let b: Biz;
beforeAll(async () => { ctx = await makeApp(); await resetData(ctx.db); await seedRates(ctx); b = await verifiedBusiness(ctx); });
afterAll(async () => closeApp(ctx));

const startFunding = async (key = `k-${randomUUID()}`) => {
  const s = await postShift(ctx, b);
  const f = await ctx.app.inject({ method: 'POST', url: `/businesses/${b.businessId}/shifts/${s.id}/fund`, headers: { ...b.owner.auth, 'idempotency-key': key } });
  return { shift: s, intent: f.json() };
};
const send = (event: object, opts: { secret?: string; ts?: number } = {}) => {
  const raw = JSON.stringify(event);
  return ctx.app.inject({
    method: 'POST', url: '/webhooks/mockpay', payload: raw,
    headers: { 'content-type': 'application/json', [MOCKPAY_SIG_HEADER]: signWebhook(opts.secret ?? ctx.config.mockpayWebhookSecret, raw, opts.ts) },
  });
};
const shiftStatus = async (id: string) => (await ctx.db.query('SELECT status FROM shifts WHERE id = $1', [id])).rows[0].status;

describe('SYS-04 webhooks', () => {
  it('rejects a forged signature, a missing signature and an old timestamp', async () => {
    const { shift, intent } = await startFunding();
    const ev = { id: `evt_${randomUUID()}`, type: 'payment.captured', data: { orderRef: intent.orderRef, amountPaise: intent.amountPaise } };
    expect((await send(ev, { secret: 'attacker-guess' })).statusCode).toBe(401);
    expect((await send(ev, { ts: Math.floor(Date.now() / 1000) - 3600 })).statusCode).toBe(401);
    const unsigned = await ctx.app.inject({ method: 'POST', url: '/webhooks/mockpay', payload: JSON.stringify(ev), headers: { 'content-type': 'application/json' } });
    expect(unsigned.statusCode).toBe(401);
    expect(await shiftStatus(shift.id)).toBe('pending_funding');
  });

  it('a replayed event is processed once: money is booked once', async () => {
    const { shift, intent } = await startFunding();
    const ev = { id: `evt_${randomUUID()}`, type: 'payment.captured', data: { orderRef: intent.orderRef, amountPaise: intent.amountPaise } };
    const before = await accountBalance(ctx.db, shiftEscrow(shift.id));
    const results = await Promise.all([send(ev), send(ev), send(ev)]);
    expect(results.every((r) => r.statusCode === 200)).toBe(true);
    // Even a new event id for the same payment doesn't double count.
    await send({ ...ev, id: `evt_${randomUUID()}` });
    expect(await accountBalance(ctx.db, shiftEscrow(shift.id))).toBe(before + intent.amountPaise);
  });

  it('an amount mismatch does not publish the shift and raises a flag', async () => {
    const { shift, intent } = await startFunding();
    const r = await send({ id: `evt_${randomUUID()}`, type: 'payment.captured', data: { orderRef: intent.orderRef, amountPaise: 100 } });
    expect(r.json().outcome).toBe('amount_mismatch');
    expect(await shiftStatus(shift.id)).toBe('pending_funding');
    const f = await ctx.db.query(`SELECT 1 FROM fraud_flags WHERE rule_code = 'payment_amount_mismatch' AND subject_id = $1`, [b.businessId]);
    expect(f.rowCount).toBe(1);
  });
});

describe('PAY-10 funding must really arrive', () => {
  it('creating a payment (the "client said success" moment) does not publish anything', async () => {
    const { shift } = await startFunding();
    expect(await shiftStatus(shift.id)).toBe('pending_funding');
  });

  it('a failed payment leaves the shift unpublished', async () => {
    const s = await postShift(ctx, b);
    const { webhook } = await fund(ctx, b, s.id, 'failure');
    expect(webhook.result.outcome).toBe('failed');
    expect(await shiftStatus(s.id)).toBe('pending_funding');
  });

  it('the same Idempotency-Key returns the same payment, never a second one', async () => {
    const key = `k-${randomUUID()}`;
    const { shift, intent } = await startFunding(key);
    const again = await ctx.app.inject({ method: 'POST', url: `/businesses/${b.businessId}/shifts/${shift.id}/fund`, headers: { ...b.owner.auth, 'idempotency-key': key } });
    expect(again.json().intentId).toBe(intent.intentId);
    const n = await ctx.db.query('SELECT count(*)::int AS n FROM payment_intents WHERE shift_id = $1', [shift.id]);
    expect(n.rows[0].n).toBe(1);
  });

  it('a funded shift cannot be funded again', async () => {
    const s = await postShift(ctx, b);
    await fund(ctx, b, s.id);
    const r = await ctx.app.inject({ method: 'POST', url: `/businesses/${b.businessId}/shifts/${s.id}/fund`, headers: { ...b.owner.auth, 'idempotency-key': `k-${randomUUID()}` } });
    expect(r.statusCode).toBe(409);
  });

  it('every journal balances, and the ledger is append-only', async () => {
    const unbalanced = await ctx.db.query(
      `SELECT journal_id FROM ledger_entries GROUP BY journal_id HAVING sum(amount_paise) <> 0`);
    expect(unbalanced.rowCount).toBe(0);
    await expect(ctx.db.query('UPDATE ledger_entries SET amount_paise = 1')).rejects.toThrow(/append-only/);
    // An unbalanced journal is refused at commit.
    const client = await ctx.db.connect();
    try {
      await client.query('BEGIN');
      const j = (await client.query(`INSERT INTO journals (kind, ref_type, ref_id, idempotency_key) VALUES ('adjustment', 'test', 'x', $1) RETURNING id`, [randomUUID()])).rows[0];
      const acct = (await client.query(`INSERT INTO ledger_accounts (code, type) VALUES ('test:x', 'test') ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code RETURNING id`)).rows[0];
      await client.query('INSERT INTO ledger_entries (journal_id, account_id, amount_paise) VALUES ($1, $2, 500)', [j.id, acct.id]);
      await expect(client.query('COMMIT')).rejects.toThrow(/does not balance/);
    } finally {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
    }
  });
});
