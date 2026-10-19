import { DEFAULT_POLICY } from '@shiftkart/db';
import type { Queryable } from './db';

/** Latest effective value for a policy key; falls back to the coded default. */
export async function getPolicy<T>(db: Queryable, key: string, scope = 'global'): Promise<T> {
  const r = await db.query(
    `SELECT value FROM policy_config WHERE key = $1 AND scope = $2 AND effective_from <= now()
     ORDER BY effective_from DESC LIMIT 1`,
    [key, scope],
  );
  if (r.rowCount) return r.rows[0].value as T;
  if (key in DEFAULT_POLICY) return DEFAULT_POLICY[key] as T;
  throw new Error(`unknown policy key ${key}`);
}
