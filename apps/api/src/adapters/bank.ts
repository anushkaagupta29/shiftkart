// Penny-drop / UPI name lookup. A real provider (Razorpay/Cashfree/Setu) replaces this, sandbox first.
export type BankCheck = { ok: true; nameAtBank: string } | { ok: false; reason: 'invalid_account' };

export interface BankVerifier {
  verify(target: { type: 'upi'; vpa: string } | { type: 'bank'; accountNo: string; ifsc: string }, expectedName: string): Promise<BankCheck>;
}

/**
 * Mock behaviour, chosen by what you type, so every path can be tried by hand:
 *  - contains "invalid"  → account doesn't exist
 *  - contains "mismatch" → account belongs to "Suresh Patil"
 *  - contains "partial"  → bank shows only the first name
 *  - anything else       → bank name equals the KYC name
 */
export class MockBank implements BankVerifier {
  async verify(target: { type: 'upi'; vpa: string } | { type: 'bank'; accountNo: string; ifsc: string }, expectedName: string): Promise<BankCheck> {
    const id = target.type === 'upi' ? target.vpa : target.accountNo;
    if (/invalid/i.test(id) || id.endsWith('0000')) return { ok: false, reason: 'invalid_account' };
    if (/mismatch/i.test(id) || id.endsWith('9999')) return { ok: true, nameAtBank: 'SURESH PATIL' };
    if (/partial/i.test(id) || id.endsWith('5555')) return { ok: true, nameAtBank: expectedName.split(/\s+/)[0]!.toUpperCase() };
    return { ok: true, nameAtBank: expectedName.toUpperCase() };
  }
}

const normalize = (s: string) =>
  s.toLowerCase().replace(/\b(mr|mrs|ms|shri|smt|kumari)\.?\b/g, ' ').replace(/[^a-z\s]/g, ' ').split(/\s+/).filter(Boolean);

/** 0-100. Token overlap, tolerant of order, titles and initials ("R. Kumar" vs "Ravi Kumar"). */
export function nameMatchScore(a: string, b: string): number {
  const x = normalize(a);
  const y = normalize(b);
  if (!x.length || !y.length) return 0;
  const used = new Set<number>();
  let matched = 0;
  for (const t of x) {
    const j = y.findIndex((u, k) => !used.has(k) && (u === t || (t.length === 1 && u.startsWith(t)) || (u.length === 1 && t.startsWith(u))));
    if (j >= 0) { used.add(j); matched += 1; }
  }
  return Math.round((matched / Math.max(x.length, y.length)) * 100);
}
