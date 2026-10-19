import { randomBytes } from 'node:crypto';
import type { Db } from '../db';

// Money out: worker payouts and refunds to businesses. A real provider (RazorpayX / Cashfree Payouts,
// sandbox first) replaces this. The mock keeps its own books in mock_provider_ledger, which is what
// daily reconciliation compares against our ledger.

export type TransferResult =
  | { ok: true; providerRef: string; duplicate: boolean }
  | { ok: false; retryable: boolean; reason: string };

export interface PayoutProvider {
  /** Idempotent on idempotencyKey: retrying the same key never sends money twice (SYS-03). */
  transfer(p: { idempotencyKey: string; amountPaise: number; destination: string }): Promise<TransferResult>;
  /** Refunds go back to the original payment only (MON-02). */
  refund(p: { idempotencyKey: string; orderRef: string; amountPaise: number }): Promise<TransferResult>;
}

export class MockPayouts implements PayoutProvider {
  constructor(private db: Db) {}

  private async record(kind: string, ref: string, key: string, amount: number, destination: string | null) {
    const ins = await this.db.query(
      `INSERT INTO mock_provider_ledger (kind, ref, idempotency_key, amount_paise, destination) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (idempotency_key) DO NOTHING RETURNING ref`,
      [kind, ref, key, amount, destination],
    );
    if (ins.rowCount) return { ok: true as const, providerRef: ins.rows[0].ref as string, duplicate: false };
    const existing = await this.db.query('SELECT ref, amount_paise FROM mock_provider_ledger WHERE idempotency_key = $1', [key]);
    if (Number(existing.rows[0].amount_paise) !== amount) return { ok: false as const, retryable: false, reason: 'idempotency_key_amount_mismatch' };
    return { ok: true as const, providerRef: existing.rows[0].ref as string, duplicate: true };
  }

  /**
   * Behaviour by destination, for trying failure paths by hand:
   *  - contains "payoutfail" → account closed (permanent failure)
   *  - contains "timeout"    → temporary failure (retried with backoff)
   */
  async transfer(p: { idempotencyKey: string; amountPaise: number; destination: string }): Promise<TransferResult> {
    if (/payoutfail/i.test(p.destination)) return { ok: false, retryable: false, reason: 'beneficiary_account_closed' };
    if (/timeout/i.test(p.destination)) return { ok: false, retryable: true, reason: 'bank_timeout' };
    return this.record('payout', `mp_pout_${randomBytes(8).toString('hex')}`, p.idempotencyKey, p.amountPaise, p.destination.replace(/^(.{2}).*(@.*)$/, '$1****$2'));
  }

  async refund(p: { idempotencyKey: string; orderRef: string; amountPaise: number }): Promise<TransferResult> {
    const r = await this.db.query(
      `SELECT COALESCE(sum(amount_paise) FILTER (WHERE kind = 'capture'), 0)::bigint
            - COALESCE(sum(amount_paise) FILTER (WHERE kind IN ('refund', 'chargeback')), 0)::bigint AS refundable
         FROM mock_provider_ledger WHERE ref = $1 OR destination = $1`,
      [p.orderRef],
    );
    const already = await this.db.query('SELECT 1 FROM mock_provider_ledger WHERE idempotency_key = $1', [p.idempotencyKey]);
    if (!already.rowCount && Number(r.rows[0].refundable) < p.amountPaise) return { ok: false, retryable: false, reason: 'refund_exceeds_capture' };
    return this.record('refund', `mp_rfnd_${randomBytes(8).toString('hex')}`, p.idempotencyKey, p.amountPaise, p.orderRef);
  }
}

export interface IntegrityVerifier {
  /** Play Integrity (or similar) verdict for a token from the device. */
  verify(token: string | undefined): Promise<'pass' | 'fail' | 'missing'>;
}

/** Mock: the test app sends "mock:pass" or "mock:fail". A missing token is reported, not blocked. */
export class MockIntegrity implements IntegrityVerifier {
  async verify(token: string | undefined) {
    if (!token) return 'missing' as const;
    return token === 'mock:fail' ? ('fail' as const) : ('pass' as const);
  }
}
