// All money is integer paise. Floats never touch money: amounts are parsed from strings
// and percentages are expressed in basis points (1% = 100 bp).

export type Paise = number;

export function assertPaise(value: number, label = 'amount'): Paise {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${label} must be an integer number of paise`);
  return value;
}

/** Parses "1234", "1234.5", "1,234.50" (rupees) into paise. Rejects more than 2 decimals. */
export function rupeesToPaise(input: string): Paise {
  const s = input.trim().replace(/,/g, '');
  const m = /^(-)?(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new RangeError(`invalid rupee amount: ${input}`);
  const [, neg, whole, frac = ''] = m;
  const paise = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return assertPaise(neg ? -paise : paise);
}

/** Formats paise in Indian grouping, e.g. 12345678 -> "₹1,23,456.78". */
export function formatINR(paise: Paise): string {
  assertPaise(paise);
  const neg = paise < 0;
  const abs = Math.abs(paise);
  const rupees = Math.floor(abs / 100).toString();
  const frac = (abs % 100).toString().padStart(2, '0');
  const last3 = rupees.slice(-3);
  const rest = rupees.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}₹${rest ? rest + ',' : ''}${last3}.${frac}`;
}

/** amount × bp / 10000, rounded half away from zero, integer-only. */
export function applyBasisPoints(amount: Paise, bp: number): Paise {
  assertPaise(amount);
  if (!Number.isSafeInteger(bp)) throw new RangeError('basis points must be an integer');
  const num = BigInt(amount) * BigInt(bp);
  const q = num / 10000n;
  const r = num % 10000n;
  const abs = r < 0n ? -r : r;
  const rounded = abs * 2n >= 10000n ? q + (num < 0n ? -1n : 1n) : q;
  return assertPaise(Number(rounded));
}

/** Splits an amount into n parts that sum exactly to the amount (remainder goes to the first parts). */
export function splitEvenly(amount: Paise, n: number): Paise[] {
  assertPaise(amount);
  if (!Number.isInteger(n) || n <= 0) throw new RangeError('n must be a positive integer');
  const base = Math.trunc(amount / n);
  const rem = amount - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < Math.abs(rem) ? Math.sign(rem) : 0));
}
