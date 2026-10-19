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

/** Several policy values in one query (safe inside a transaction, where queries can't run in parallel). */
export async function getPolicies<K extends string>(db: Queryable, keys: readonly K[], scope = 'global'): Promise<Record<K, number>> {
  const r = await db.query(
    // A state-scoped value (e.g. scope "state:KA") wins; otherwise the global one; otherwise the coded default.
    `SELECT DISTINCT ON (key) key, value FROM policy_config
      WHERE key = ANY($1) AND scope IN ($2, 'global') AND effective_from <= now() ORDER BY key, (scope = $2) DESC, effective_from DESC`,
    [keys, scope],
  );
  const found = Object.fromEntries(r.rows.map((x) => [x.key, x.value]));
  const out = {} as Record<K, number>;
  for (const k of keys) {
    const v = k in found ? found[k] : DEFAULT_POLICY[k];
    if (v === undefined) throw new Error(`unknown policy key ${k}`);
    out[k] = v as number;
  }
  return out;
}
