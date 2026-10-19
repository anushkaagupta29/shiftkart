// RFC 6238 TOTP (SHA-1, 6 digits, 30s) for staff 2FA. No external dependency.
import { createHmac, randomBytes } from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, '').toUpperCase();
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpStep(atMs: number, periodSec = 30): number {
  return Math.floor(atMs / 1000 / periodSec);
}

export function hotp(secretB32: string, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', base32Decode(secretB32)).update(msg).digest();
  const off = h[h.length - 1]! & 0xf;
  const bin = ((h[off]! & 0x7f) << 24) | (h[off + 1]! << 16) | (h[off + 2]! << 8) | h[off + 3]!;
  return (bin % 10 ** digits).toString().padStart(digits, '0');
}

export function totp(secretB32: string, atMs = Date.now()): string {
  return hotp(secretB32, totpStep(atMs));
}

/** Returns the matching step (for replay protection) or null. Accepts ±window steps of clock drift. */
export function verifyTotp(secretB32: string, code: string, atMs = Date.now(), window = 1): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const now = totpStep(atMs);
  for (let s = now - window; s <= now + window; s++) if (hotp(secretB32, s) === code) return s;
  return null;
}
