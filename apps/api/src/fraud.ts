import type { Queryable } from './db';

export type FlagSubject = 'worker' | 'business' | 'shift' | 'device' | 'payout_method' | 'system';

/** Opens a fraud flag for human review. One open flag per subject + rule (duplicates are merged). */
export async function raiseFlag(db: Queryable, subjectType: FlagSubject, subjectId: string, ruleCode: string, evidence: Record<string, unknown> = {}, score = 50) {
  await db.query(
    `INSERT INTO fraud_flags (subject_type, subject_id, rule_code, score, evidence) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (subject_type, subject_id, rule_code) WHERE status = 'open'
     DO UPDATE SET evidence = fraud_flags.evidence || EXCLUDED.evidence, score = GREATEST(fraud_flags.score, EXCLUDED.score)`,
    [subjectType, subjectId, ruleCode, score, JSON.stringify(evidence)],
  );
}
