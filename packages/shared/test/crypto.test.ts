import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decrypt, encrypt, hashPassword, lookupHash, verifyPassword } from '../src/crypto';
import { canonicalJson } from '../src/canonical';
import { base32Encode, hotp, verifyTotp, totp } from '../src/totp';

const key = randomBytes(32).toString('base64');

describe('crypto', () => {
  it('encrypts and decrypts; tampering fails', () => {
    const c = encrypt('+919876543210', key);
    expect(c).not.toContain('9876543210');
    expect(decrypt(c, key)).toBe('+919876543210');
    const parts = c.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => decrypt(parts.join('.'), key)).toThrow();
  });
  it('uses random IVs', () => {
    expect(encrypt('x', key)).not.toBe(encrypt('x', key));
  });
  it('lookup hash is deterministic and keyed', () => {
    expect(lookupHash('a', key)).toBe(lookupHash('a', key));
    expect(lookupHash('a', key)).not.toBe(lookupHash('a', randomBytes(32).toString('base64')));
  });
  it('rejects wrong-size keys', () => {
    expect(() => encrypt('x', 'c2hvcnQ=')).toThrow(/32 bytes/);
  });
  it('hashes passwords', async () => {
    const h = await hashPassword('correct horse');
    expect(await verifyPassword('correct horse', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
  });
  it('canonical json sorts keys', () => {
    expect(canonicalJson({ b: 1, a: { d: undefined, c: 2 } })).toBe('{"a":{"c":2},"b":1}');
  });
});

describe('totp (RFC 6238 vectors)', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  it('matches RFC 4226 HOTP vectors', () => {
    expect(hotp(secret, 0)).toBe('755224');
    expect(hotp(secret, 9)).toBe('520489');
  });
  it('matches RFC 6238 at T=59s', () => {
    // RFC gives 8-digit 94287082; 6-digit is the last six.
    expect(totp(secret, 59_000)).toBe('287082');
  });
  it('accepts ±1 step, rejects older', () => {
    const now = 1_700_000_000_000;
    expect(verifyTotp(secret, totp(secret, now - 30_000), now)).not.toBeNull();
    expect(verifyTotp(secret, totp(secret, now - 90_000), now)).toBeNull();
    expect(verifyTotp(secret, 'abcdef', now)).toBeNull();
  });
});
