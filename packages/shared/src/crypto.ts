import { createCipheriv, createDecipheriv, createHmac, randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;

function key32(b64: string, name: string): Buffer {
  const k = Buffer.from(b64 ?? '', 'base64');
  if (k.length !== 32) throw new Error(`${name} must be 32 bytes, base64-encoded`);
  return k;
}

/** AES-256-GCM. Output: "v1.<iv>.<tag>.<ciphertext>" (base64url parts). */
export function encrypt(plaintext: string, dataKeyB64: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key32(dataKeyB64, 'DATA_KEY'), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function decrypt(token: string, dataKeyB64: string): string {
  const [v, iv, tag, ct] = token.split('.');
  if (v !== 'v1' || !iv || !tag || ct === undefined) throw new Error('unsupported ciphertext');
  const d = createDecipheriv('aes-256-gcm', key32(dataKeyB64, 'DATA_KEY'), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}

/** Keyed hash for lookups and dedup (phone, bank account, ...). Not reversible without the key. */
export function lookupHash(value: string, hashKeyB64: string): string {
  return createHmac('sha256', key32(hashKeyB64, 'HASH_KEY')).update(value).digest('base64url');
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function randomToken(prefix: string, bytes = 32): string {
  return `${prefix}${randomBytes(bytes).toString('base64url')}`;
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const SCRYPT = { N: 16384, r: 8, p: 1 };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 32, SCRYPT);
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64url');
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64url'), expected.length, SCRYPT);
  return timingSafeEqual(actual, expected);
}
