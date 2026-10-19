import type { Tx } from './db';

export type Posting = { account: string; type: string; ownerId?: string | null; amountPaise: number };

/**
 * Posts a balanced journal. Idempotent: the same key posts once, so a retried request or a
 * duplicate webhook can never move money twice. Balance is also enforced by a DB trigger at commit.
 */
export async function postJournal(
  tx: Tx,
  j: { kind: string; refType: string; refId: string; idempotencyKey: string; memo?: string; createdBy?: string | null },
  postings: Posting[],
  opts: { nonNegative?: string[] } = {},
): Promise<{ journalId: string; duplicate: boolean }> {
  const sum = postings.reduce((a, p) => a + p.amountPaise, 0);
  if (sum !== 0) throw new Error(`unbalanced journal (${sum})`);
  for (const p of postings) if (!Number.isSafeInteger(p.amountPaise) || p.amountPaise === 0) throw new Error('bad posting amount');

  const ins = await tx.query(
    `INSERT INTO journals (kind, ref_type, ref_id, idempotency_key, memo, created_by) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
    [j.kind, j.refType, j.refId, j.idempotencyKey, j.memo ?? null, j.createdBy ?? null],
  );
  if (!ins.rowCount) {
    const existing = await tx.query('SELECT id FROM journals WHERE idempotency_key = $1', [j.idempotencyKey]);
    return { journalId: existing.rows[0].id, duplicate: true };
  }
  const journalId = ins.rows[0].id as string;
  for (const p of postings) {
    const acct = await tx.query(
      `INSERT INTO ledger_accounts (code, type, owner_id) VALUES ($1, $2, $3)
       ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code RETURNING id`,
      [p.account, p.type, p.ownerId ?? null],
    );
    await tx.query('INSERT INTO ledger_entries (journal_id, account_id, amount_paise) VALUES ($1, $2, $3)', [journalId, acct.rows[0].id, p.amountPaise]);
  }
  // SYS-05: money we hold for a shift can never go below zero (no paying out more than was funded).
  for (const code of opts.nonNegative ?? []) {
    const bal = await accountBalance(tx, code);
    if (bal < 0) throw new Error(`insufficient funds in ${code} (would be ${bal})`);
  }
  return { journalId, duplicate: false };
}

export async function accountBalance(tx: Tx | import('pg').Pool, code: string): Promise<number> {
  const r = await tx.query(
    `SELECT COALESCE(sum(e.amount_paise), 0)::bigint AS bal FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id WHERE a.code = $1`,
    [code],
  );
  return r.rows[0].bal;
}

/** Money held for one shift: funded in, wages/fees/refunds out. Settles to zero when the shift closes. */
export const shiftEscrow = (shiftId: string) => `shift_escrow:${shiftId}`;
export const workerPayable = (workerId: string) => `worker_payable:${workerId}`;
export const PLATFORM_REVENUE = 'platform_revenue';
export const GST_PAYABLE = 'gst_payable';
export const CHARGEBACK_LOSS = 'chargeback_loss';
export const PLATFORM_ADJUSTMENTS = 'platform_adjustments';
export const clearingAccount = (provider: string) => `provider_clearing:${provider}`;
