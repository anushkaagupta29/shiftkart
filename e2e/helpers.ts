// Direct API/DB helpers for E2E setup steps that aren't the journey under test.
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { encrypt, hashPassword, newTotpSecret, totp } from '@shiftkart/shared';
import { loadRootEnv, requireEnv } from '@shiftkart/db';

loadRootEnv();
export const API = 'http://localhost:4000';
export const db = new pg.Pool({ connectionString: requireEnv('DATABASE_URL'), max: 2 });

export const randomPhone = () => `9${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;

let gst = Math.floor(Math.random() * 9000) + 1000;
export function freshGstin(legalName: string) {
  gst += 1;
  const pan = `PWTST${gst}Q`;
  const gstin = `29${pan}1Z5`;
  return { gstin, pan, register: () => db.query('INSERT INTO mock_gstn_registry (gstin, legal_name) VALUES ($1, $2) ON CONFLICT DO NOTHING', [gstin, legalName]) };
}

/** A staff account made just for this test run, with a known password and 2FA secret. */
export async function makeStaff(roles: string[]) {
  const email = `e2e-${randomBytes(4).toString('hex')}@shiftkart.local`;
  const password = randomBytes(9).toString('base64url');
  const secret = newTotpSecret();
  await db.query(
    `INSERT INTO staff_users (email, name, password_hash, totp_secret_enc, roles) VALUES ($1, 'E2E', $2, $3, $4)`,
    [email, await hashPassword(password), encrypt(secret, requireEnv('DATA_KEY')), roles],
  );
  return { email, password, code: () => totp(secret) };
}

async function call(path: string, init: RequestInit & { token?: string } = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), ...(init.headers ?? {}) },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${path} ${res.status} ${JSON.stringify(body)}`);
  return body;
}

export async function otpLogin(phone: string, kind: 'worker' | 'business') {
  await call('/auth/otp/request', { method: 'POST', body: JSON.stringify({ phone }) });
  const out = await call('/dev/outbox', { method: 'POST', body: JSON.stringify({ phone }) });
  const code = out[0].body.match(/\d{6}/)[0];
  const r = await call('/auth/otp/verify', {
    method: 'POST', body: JSON.stringify({ phone, code, deviceId: `e2e-${randomUUID()}`, signup: { kind, lang: 'en', consents: ['account'] } }),
  });
  return r.accessToken as string;
}

/** A verified business with a live, funded shift near Whitefield. Built through the API. */
export async function liveShiftViaApi(title: string, ownerPhone = randomPhone()) {
  const token = await otpLogin(ownerPhone, 'business');
  const legalName = `E2E Logistics ${randomBytes(3).toString('hex')} Pvt Ltd`;
  const biz = await call('/businesses', { method: 'POST', token, body: JSON.stringify({ legalName }) });
  await call(`/businesses/${biz.id}/sites`, { method: 'POST', token, body: JSON.stringify({ name: 'E2E Dock', address: 'Dock 3, Whitefield Industrial Area, Bengaluru', cityCode: 'BLR', lat: 12.979, lng: 77.731 }) });
  const g = freshGstin(legalName);
  await g.register();
  await call(`/businesses/${biz.id}/verification`, { method: 'PUT', token, body: JSON.stringify({ gstin: g.gstin, pan: g.pan, signatoryName: 'E2E Owner' }) });
  await db.query(`UPDATE businesses SET verification_status = 'verified', verified_at = now() - interval '90 days' WHERE id = $1`, [biz.id]);
  await db.query(`UPDATE sites SET status = 'active' WHERE business_id = $1`, [biz.id]);
  const day = new Date(Date.now() + 330 * 60_000 + 3 * 86400_000).toISOString().slice(0, 10);
  const ist = (h: number) => new Date(Date.parse(`${day}T00:00:00Z`) + (h * 60 - 330) * 60_000).toISOString();
  const sites = await call(`/businesses/${biz.id}/sites`, { token });
  const shift = await call(`/businesses/${biz.id}/shifts`, {
    method: 'POST', token,
    body: JSON.stringify({ siteId: sites[0].id, roleCode: 'warehouse_packing', title, startsAt: ist(10), endsAt: ist(16), headcount: 2, payType: 'hourly', payPaise: 11000, breakMinutes: 0, mealAllowancePaise: 5000 }),
  });
  const f = await call(`/businesses/${biz.id}/shifts/${shift.id}/fund`, { method: 'POST', token, headers: { 'idempotency-key': `e2e-${randomUUID()}` } });
  await call(`/mockpay/checkout/${f.intentId}`, { method: 'POST', body: JSON.stringify({ outcome: 'success' }) });
  return { businessId: biz.id as string, shiftId: shift.id as string, token, ownerPhone };
}

/** A fully onboarded worker (mock KYC, selfie, UPI, profile), built through the API. */
export async function workerViaApi() {
  const phone = randomPhone();
  await call('/auth/otp/request', { method: 'POST', body: JSON.stringify({ phone }) });
  const out = await call('/dev/outbox', { method: 'POST', body: JSON.stringify({ phone }) });
  const code = out[0].body.match(/\d{6}/)[0];
  const t = await call('/auth/otp/verify', { method: 'POST', body: JSON.stringify({ phone, code, deviceId: `e2e-${randomUUID()}`, platform: 'web', signup: { kind: 'worker', lang: 'hi', consents: ['account', 'location_at_shift', 'face_verification'] } }) });
  const token = t.accessToken as string;
  const k = await call('/worker/kyc/start', { method: 'POST', token });
  const personId = `e2e-${randomUUID()}`;
  await call(`/mock/digilocker/${k.sessionId}/approve`, { method: 'POST', body: JSON.stringify({ personId, name: 'Sunita Rao', dob: '1994-08-15' }) });
  await call('/worker/kyc/complete', { method: 'POST', token, body: JSON.stringify({ sessionId: k.sessionId }) });
  await call('/worker/selfie', { method: 'POST', token, body: JSON.stringify({ mockPersonId: personId }) });
  await call('/worker/payout-method', { method: 'POST', token, body: JSON.stringify({ type: 'upi', vpa: `sunita${Date.now()}@okaxis` }) });
  await call('/worker/profile', { method: 'PUT', token, body: JSON.stringify({ languages: ['hi'], skills: ['packing'], travelRadiusKm: 30, hasTwoWheeler: false, homeCity: 'BLR' }) });
  return { phone, token, refreshToken: t.refreshToken as string, personId };
}

export const api = call;
