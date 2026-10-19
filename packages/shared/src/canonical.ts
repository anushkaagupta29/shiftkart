/** Deterministic JSON (sorted keys, no undefined) used for hash chains. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

function normalize(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(normalize);
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      const val = (v as Record<string, unknown>)[k];
      if (val !== undefined) out[k] = normalize(val);
    }
    return out;
  }
  return v;
}
