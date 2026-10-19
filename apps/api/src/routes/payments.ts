import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app';
import { withTx } from '../db';
import { writeAudit } from '../audit';
import { raiseFlag } from '../fraud';
import { clearingAccount, postJournal, shiftEscrow } from '../ledger';
import { parse } from '../lib/validate';
import { HttpError, badRequest, conflict, notFound } from '../lib/errors';
import { userActor } from '../auth/guard';
import { requireMember } from './businesses';
import { MOCKPAY_SIG_HEADER, newProviderRef, signWebhook, verifyWebhookSignature, type MockpayEvent } from '../adapters/mockpay';
import { handleChargeback, handlePayoutReversal } from '../money';
import { overtimeFunded } from '../overtime';
import { hireFeePaid } from '../conversion';

const PROVIDER = 'mockpay';
const bizAuth = { auth: { user: { kinds: ['business' as const] } } };
const ShiftParams = z.object({ businessId: z.string().uuid(), shiftId: z.string().uuid() }).strict();
const IntentParams = z.object({ businessId: z.string().uuid(), intentId: z.string().uuid() }).strict();

const Event = z.object({
  id: z.string().min(5).max(100),
  type: z.enum(['payment.captured', 'payment.failed', 'payment.chargeback', 'payout.reversed']),
  data: z.object({ orderRef: z.string().max(100), amountPaise: z.number().int().positive() }),
});

export async function paymentRoutes(app: FastifyInstance, deps: AppDeps) {
  const { db, config } = deps;

  /**
   * Starts funding. The business funds the whole shift before it goes live. The Idempotency-Key header
   * makes double-clicks and retries return the same payment instead of creating a second one.
   */
  app.post('/businesses/:businessId/shifts/:shiftId/fund', { config: bizAuth }, async (req, reply) => {
    const a = userActor(req);
    const { businessId, shiftId } = parse(ShiftParams, req.params);
    const key = req.headers['idempotency-key'];
    if (typeof key !== 'string' || key.length < 8 || key.length > 100) throw badRequest('idempotency_key_required', 'Send an Idempotency-Key header (8-100 characters).');
    const intent = await withTx(db, async (tx) => {
      await requireMember(tx, businessId, a.userId, ['owner', 'manager']);
      const s = (await tx.query('SELECT * FROM shifts WHERE id = $1 AND business_id = $2 FOR UPDATE', [shiftId, businessId])).rows[0];
      if (!s) throw notFound();
      const existing = (await tx.query('SELECT * FROM payment_intents WHERE idempotency_key = $1', [`${businessId}:${key}`])).rows[0];
      if (existing) {
        if (existing.shift_id !== shiftId) throw conflict('idempotency_key_reused', 'This Idempotency-Key was used for a different payment.');
        return existing;
      }
      if (s.status !== 'pending_funding') throw conflict('not_fundable', s.status === 'live' ? 'This shift is already funded.' : 'This shift cannot be funded right now.');
      if (s.starts_at <= new Date()) throw conflict('not_fundable', 'This shift has already started.');
      const i = (await tx.query(
        `INSERT INTO payment_intents (business_id, shift_id, amount_paise, provider, provider_ref, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [businessId, shiftId, s.total_paise, PROVIDER, newProviderRef(), `${businessId}:${key}`],
      )).rows[0];
      await writeAudit(tx, { actorType: 'user', actorId: a.userId, action: 'payment.intent_create', targetType: 'shift', targetId: shiftId, after: { intentId: i.id, amountPaise: i.amount_paise }, ip: req.ip });
      return i;
    });
    reply.code(201);
    return { intentId: intent.id, orderRef: intent.provider_ref, amountPaise: intent.amount_paise, status: intent.status, checkoutPath: `/pay/${intent.id}` };
  });

  app.get('/businesses/:businessId/payments/:intentId', { config: bizAuth }, async (req) => {
    const a = userActor(req);
    const { businessId, intentId } = parse(IntentParams, req.params);
    await requireMember(db, businessId, a.userId);
    const i = (await db.query('SELECT * FROM payment_intents WHERE id = $1 AND business_id = $2', [intentId, businessId])).rows[0];
    if (!i) throw notFound();
    return { intentId: i.id, shiftId: i.shift_id, orderRef: i.provider_ref, amountPaise: i.amount_paise, status: i.status, capturedAt: i.captured_at };
  });

  // Webhooks need the exact raw body to check the signature, so this scope parses JSON as a string.
  await app.register(async (hooks) => {
    hooks.removeContentTypeParser('application/json');
    hooks.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body));

    hooks.post('/webhooks/mockpay', { config: { auth: { public: true } } }, async (req) => {
      const raw = typeof req.body === 'string' ? req.body : '';
      // SYS-04: unsigned or forged webhooks are rejected before anything is read.
      if (!verifyWebhookSignature(config.mockpayWebhookSecret, raw, req.headers[MOCKPAY_SIG_HEADER] as string | undefined)) {
        throw new HttpError(401, 'bad_signature', 'Invalid signature.');
      }
      let event: MockpayEvent;
      try { event = parse(Event, JSON.parse(raw)); } catch { throw badRequest('bad_event', 'Malformed event.'); }
      return processEvent(event);
    });
  });

  async function processEvent(event: MockpayEvent) {
    return withTx(db, async (tx) => {
      const ins = await tx.query(
        `INSERT INTO webhook_events (provider, event_id, event_type, payload) VALUES ($1, $2, $3, $4)
         ON CONFLICT (provider, event_id) DO NOTHING RETURNING id`,
        [PROVIDER, event.id, event.type, JSON.stringify(event)],
      );
      if (!ins.rowCount) return { ok: true, duplicate: true }; // replayed event: already handled
      const eventRow = ins.rows[0].id;
      const done = (outcome: string) => tx.query('UPDATE webhook_events SET processed_at = now(), outcome = $2 WHERE id = $1', [eventRow, outcome]).then(() => ({ ok: true, outcome }));

      if (event.type === 'payment.chargeback') return done(await handleChargeback(tx, event.data.orderRef, event.data.amountPaise));
      if (event.type === 'payout.reversed') return done(await handlePayoutReversal(tx, event.data.orderRef));
      const intent = (await tx.query('SELECT * FROM payment_intents WHERE provider_ref = $1 FOR UPDATE', [event.data.orderRef])).rows[0];
      if (!intent) return done('unknown_order');
      if (event.type === 'payment.failed') {
        if (intent.status === 'created') await tx.query(`UPDATE payment_intents SET status = 'failed' WHERE id = $1`, [intent.id]);
        return done('failed');
      }
      if (intent.status === 'captured') return done('already_captured');
      // Amount must match exactly what we asked for.
      if (event.data.amountPaise !== Number(intent.amount_paise)) {
        await raiseFlag(tx, 'business', intent.business_id, 'payment_amount_mismatch', { intentId: intent.id, expected: intent.amount_paise, got: event.data.amountPaise }, 90);
        return done('amount_mismatch');
      }
      await tx.query(`UPDATE payment_intents SET status = 'captured', captured_at = now() WHERE id = $1`, [intent.id]);
      if (intent.purpose !== 'conversion') await postJournal(tx, { kind: 'fund', refType: 'payment_intent', refId: intent.id, idempotencyKey: `fund:${intent.id}`, memo: 'Shift funded' }, [
        { account: shiftEscrow(intent.shift_id), type: 'shift_escrow', ownerId: intent.business_id, amountPaise: Number(intent.amount_paise) },
        { account: clearingAccount(PROVIDER), type: 'provider_clearing', amountPaise: -Number(intent.amount_paise) },
      ]);
      if (intent.purpose === 'conversion') {
        await hireFeePaid(tx, intent.hire_request_id, intent.id);
        return done('captured_conversion');
      }
      if (intent.purpose === 'overtime') {
        await overtimeFunded(tx, intent.overtime_request_id, deps.sms, config.dataKey);
        return done('captured_overtime');
      }
      const pub = await tx.query(
        `UPDATE shifts SET status = 'live', published_at = now() WHERE id = $1 AND status = 'pending_funding' RETURNING id`,
        [intent.shift_id],
      );
      if (!pub.rowCount) {
        // Money arrived for a shift that can't go live (e.g. withdrawn meanwhile): finance refunds it.
        await raiseFlag(tx, 'shift', intent.shift_id, 'funded_inactive_shift', { intentId: intent.id }, 60);
        return done('captured_shift_inactive');
      }
      await writeAudit(tx, { actorType: 'system', action: 'shift.published', targetType: 'shift', targetId: intent.shift_id, after: { intentId: intent.id, amountPaise: intent.amount_paise } });
      return done('captured');
    });
  }

  /**
   * Dev-only stand-in for the provider's hosted checkout page: the tester picks success or failure,
   * and the "provider" sends us a properly signed webhook, exactly like a real one would.
   */
  if (config.devEndpoints && config.env !== 'production') {
    app.post('/mockpay/checkout/:intentId', { config: { auth: { public: true } } }, async (req) => {
      const { intentId } = parse(z.object({ intentId: z.string().uuid() }).strict(), req.params);
      const { outcome, amountPaise } = parse(z.object({ outcome: z.enum(['success', 'failure']), amountPaise: z.number().int().positive().optional() }).strict(), req.body);
      const i = (await db.query('SELECT * FROM payment_intents WHERE id = $1', [intentId])).rows[0];
      if (!i) throw notFound();
      // The provider's own books record the capture, independently of whether our webhook handler works.
      if (outcome === 'success') {
        await db.query(
          `INSERT INTO mock_provider_ledger (kind, ref, idempotency_key, amount_paise) VALUES ('capture', $1, $2, $3) ON CONFLICT DO NOTHING`,
          [i.provider_ref, `capture:${i.provider_ref}`, amountPaise ?? Number(i.amount_paise)],
        );
      }
      const event: MockpayEvent = {
        id: `evt_${randomUUID()}`,
        type: outcome === 'success' ? 'payment.captured' : 'payment.failed',
        data: { orderRef: i.provider_ref, amountPaise: amountPaise ?? Number(i.amount_paise) },
      };
      const raw = JSON.stringify(event);
      const res = await app.inject({
        method: 'POST', url: '/webhooks/mockpay', payload: raw,
        headers: { 'content-type': 'application/json', [MOCKPAY_SIG_HEADER]: signWebhook(config.mockpayWebhookSecret, raw) },
      });
      return { webhookStatus: res.statusCode, result: res.json() };
    });
  }
}
