import { canonicalJson, sha256 } from '@shiftkart/shared';
import type { Db, Queryable, Tx } from './db';

export type AuditEntry = {
  actorType: 'staff' | 'user' | 'system';
  actorId?: string | null;
  actorRoles?: string[];
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  reason?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
};

const GENESIS = 'GENESIS';
const AUDIT_LOCK = 919191;

function hashOf(prevHash: string, row: Record<string, unknown>): string {
  return sha256(prevHash + canonicalJson(row));
}

function rowFor(at: string, e: AuditEntry) {
  // JSON round-trip so the hashed form equals what jsonb gives back later.
  const json = (v: unknown) => (v === undefined || v === null ? null : JSON.parse(JSON.stringify(v)));
  return {
    at,
    actorType: e.actorType,
    actorId: e.actorId ?? null,
    actorRoles: e.actorRoles ?? [],
    action: e.action,
    targetType: e.targetType ?? null,
    targetId: e.targetId ?? null,
    reason: e.reason ?? null,
    before: json(e.before),
    after: json(e.after),
    ip: e.ip ?? null,
  };
}

/**
 * Appends to the hash-chained audit log. Must run inside a transaction (pass the tx client),
 * so the audit entry commits or rolls back together with the change it describes.
 */
export async function writeAudit(tx: Tx, e: AuditEntry): Promise<void> {
  await tx.query('SELECT pg_advisory_xact_lock($1)', [AUDIT_LOCK]);
  const prev = await tx.query('SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1');
  const prevHash: string = prev.rows[0]?.hash ?? GENESIS;
  const row = rowFor(new Date().toISOString(), e);
  const hash = hashOf(prevHash, row);
  await tx.query(
    `INSERT INTO audit_log (at, actor_type, actor_id, actor_roles, action, target_type, target_id, reason, before, after, ip, prev_hash, hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [row.at, row.actorType, row.actorId, row.actorRoles, row.action, row.targetType, row.targetId, row.reason,
     row.before === null ? null : JSON.stringify(row.before), row.after === null ? null : JSON.stringify(row.after),
     row.ip, prevHash, hash],
  );
}

/** Convenience for callers that are not already in a transaction. */
export async function audit(db: Db, e: AuditEntry): Promise<void> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await writeAudit(client, e);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export type ChainResult = { ok: boolean; checked: number; brokenAtSeq?: number };

/** Recomputes every hash in order. Any edited, inserted or deleted row breaks the chain. */
export async function verifyAuditChain(db: Queryable): Promise<ChainResult> {
  const { rows } = await db.query('SELECT * FROM audit_log ORDER BY seq');
  let prevHash = GENESIS;
  for (const r of rows) {
    const row = rowFor(new Date(r.at).toISOString(), {
      actorType: r.actor_type, actorId: r.actor_id, actorRoles: r.actor_roles, action: r.action,
      targetType: r.target_type, targetId: r.target_id, reason: r.reason, before: r.before, after: r.after, ip: r.ip,
    });
    if (r.prev_hash !== prevHash || hashOf(prevHash, row) !== r.hash) {
      return { ok: false, checked: rows.length, brokenAtSeq: Number(r.seq) };
    }
    prevHash = r.hash;
  }
  return { ok: true, checked: rows.length };
}
