// Builders for Phase 2 tests: verified businesses, funded shifts and verified workers.
import { randomUUID } from 'node:crypto';
import { encrypt, lookupHash } from '@shiftkart/shared';
import { mockEmbedding, toPgVector } from '../src/adapters/mock-face';
import { createSession } from '../src/auth/sessions';
import { withTx } from '../src/db';
import { fakePhone, signUp, staffWith, type Ctx, type LoggedIn, type StaffLogin } from './helpers';

export const BLR = { lat: 12.9716, lng: 77.5946 };
export const WHITEFIELD = { lat: 12.979, lng: 77.731 };

/** SAMPLE rates for tests: zone A unskilled ₹640/day → ₹80/h; semi-skilled ₹700/day → ₹87.50/h. */
export async function seedRates(ctx: Ctx) {
  await ctx.db.query(
    `INSERT INTO min_wage_rates (state_code, wage_category, zone, basic_paise_per_day, vda_paise_per_day, effective_from, source_ref, status) VALUES
      ('KA', 'unskilled', 'A', 60000, 4000, '2026-01-01', 'test', 'active'),
      ('KA', 'semi_skilled', 'A', 66000, 4000, '2026-01-01', 'test', 'active'),
      ('KA', 'skilled', 'A', 72000, 4000, '2026-01-01', 'test', 'active')`,
  );
}

/** ISO time `daysAhead` days from now at `hourIST`:`minute` IST, whole minutes. */
export function istSlot(daysAhead: number, hourIST: number, minute = 0): string {
  const now = new Date();
  const ist = new Date(now.getTime() + 330 * 60_000);
  const day = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) + daysAhead * 86400_000;
  return new Date(day + (hourIST * 60 + minute - 330) * 60_000).toISOString();
}

let gstCounter = 1000;
/** A fresh, well-formed Karnataka GSTIN and its PAN (GSTIN characters 3-12). */
export function newGstin(): { gstin: string; pan: string } {
  gstCounter += 1;
  const pan = `ABCDE${gstCounter}F`;
  return { gstin: `29${pan}1Z5`, pan };
}

export type Biz = { owner: LoggedIn; businessId: string; siteId: string; verifier: StaffLogin };

export async function verifiedBusiness(ctx: Ctx, opts: { legalName?: string; verifier?: StaffLogin } = {}): Promise<Biz> {
  const legalName = opts.legalName ?? `Test Traders ${randomUUID().slice(0, 6)} Pvt Ltd`;
  const owner = await signUp(ctx, 'business');
  const biz = (await ctx.app.inject({ method: 'POST', url: '/businesses', headers: owner.auth, payload: { legalName } })).json();
  const site = await ctx.app.inject({
    method: 'POST', url: `/businesses/${biz.id}/sites`, headers: owner.auth,
    payload: { name: 'Main warehouse', address: '12 Industrial Area, Whitefield, Bengaluru', cityCode: 'BLR', ...WHITEFIELD },
  });
  const { gstin, pan } = newGstin();
  await ctx.db.query('INSERT INTO mock_gstn_registry (gstin, legal_name) VALUES ($1, $2)', [gstin, legalName]);
  const sub = await ctx.app.inject({
    method: 'PUT', url: `/businesses/${biz.id}/verification`, headers: owner.auth,
    payload: { gstin, pan, signatoryName: 'Asha Rao' },
  });
  if (sub.statusCode !== 200) throw new Error(`submit failed ${sub.body}`);
  const verifier = opts.verifier ?? (await staffWith(ctx, ['ops_verifier']));
  const rev = await ctx.app.inject({ method: 'POST', url: `/admin/businesses/${biz.id}/review`, headers: verifier.cookie, payload: { decision: 'approve', reason: 'Documents match' } });
  if (rev.json().status !== 'verified') throw new Error(`review failed ${rev.body}`);
  // Treat as established (not in the first-30-days limits) unless a test wants otherwise.
  await ctx.db.query(`UPDATE businesses SET verified_at = now() - interval '90 days' WHERE id = $1`, [biz.id]);
  return { owner, businessId: biz.id, siteId: site.json().id, verifier };
}

export function shiftBody(siteId: string, over: Record<string, unknown> = {}) {
  return {
    siteId, roleCode: 'warehouse_packing', title: 'Parcel packing for sale week',
    description: 'Pack and label parcels.', startsAt: istSlot(2, 9), endsAt: istSlot(2, 17), breakMinutes: 30,
    headcount: 5, payType: 'hourly', payPaise: 10000, mealAllowancePaise: 5000, travelAllowancePaise: 0,
    requirements: { skills: [], languages: [], twoWheeler: false }, dressCode: 'Closed shoes', bringItems: 'ID card',
    ...over,
  };
}

export async function postShift(ctx: Ctx, b: Biz, over: Record<string, unknown> = {}) {
  const r = await ctx.app.inject({ method: 'POST', url: `/businesses/${b.businessId}/shifts`, headers: b.owner.auth, payload: shiftBody(b.siteId, over) });
  if (r.statusCode !== 201) throw new Error(`post shift failed ${r.statusCode} ${r.body}`);
  return r.json();
}

export async function fund(ctx: Ctx, b: Biz, shiftId: string, outcome: 'success' | 'failure' = 'success') {
  const f = await ctx.app.inject({
    method: 'POST', url: `/businesses/${b.businessId}/shifts/${shiftId}/fund`, headers: { ...b.owner.auth, 'idempotency-key': `key-${randomUUID()}` },
  });
  if (f.statusCode !== 201) throw new Error(`fund failed ${f.body}`);
  const c = await ctx.app.inject({ method: 'POST', url: `/mockpay/checkout/${f.json().intentId}`, payload: { outcome } });
  return { intent: f.json(), webhook: c.json() };
}

export async function liveShift(ctx: Ctx, b: Biz, over: Record<string, unknown> = {}) {
  const s = await postShift(ctx, b, over);
  await fund(ctx, b, s.id);
  return s;
}

export type Worker = LoggedIn & { personId: string };

/** Full onboarding through the API: KYC, selfie, UPI, profile. */
export async function verifiedWorker(ctx: Ctx, opts: { name?: string; dob?: string; personId?: string; faceId?: string; vpa?: string; skills?: string[]; languages?: string[]; twoWheeler?: boolean } = {}): Promise<Worker> {
  const w = await signUp(ctx, 'worker');
  const personId = opts.personId ?? `person-${randomUUID()}`;
  const start = (await ctx.app.inject({ method: 'POST', url: '/worker/kyc/start', headers: w.auth })).json();
  await ctx.app.inject({
    method: 'POST', url: `/mock/digilocker/${start.sessionId}/approve`,
    payload: { personId, name: opts.name ?? 'Ravi Kumar', dob: opts.dob ?? '1998-05-14', ...(opts.faceId ? { faceId: opts.faceId } : {}) },
  });
  const k = await ctx.app.inject({ method: 'POST', url: '/worker/kyc/complete', headers: w.auth, payload: { sessionId: start.sessionId } });
  if (k.statusCode !== 200) throw new Error(`kyc failed ${k.statusCode} ${k.body}`);
  const sf = await ctx.app.inject({ method: 'POST', url: '/worker/selfie', headers: w.auth, payload: { mockPersonId: opts.faceId ?? personId } });
  if (sf.statusCode !== 200) throw new Error(`selfie failed ${sf.body}`);
  const pm = await ctx.app.inject({ method: 'POST', url: '/worker/payout-method', headers: w.auth, payload: { type: 'upi', vpa: opts.vpa ?? `w${randomUUID().slice(0, 8)}@okaxis` } });
  if (pm.statusCode !== 201) throw new Error(`payout failed ${pm.body}`);
  const pr = await ctx.app.inject({
    method: 'PUT', url: '/worker/profile', headers: w.auth,
    payload: { languages: opts.languages ?? ['hi', 'kn'], skills: opts.skills ?? ['packing', 'loading'], travelRadiusKm: 25, hasTwoWheeler: opts.twoWheeler ?? false, homeCity: 'BLR', homeLat: BLR.lat, homeLng: BLR.lng },
  });
  if (pr.json().verificationStatus !== 'verified') throw new Error(`not verified: ${pr.body}`);
  return { ...w, personId };
}

/**
 * Many verified workers straight in the database (for concurrency tests, where onboarding
 * 200 people through the API would only slow the test down). Returns bearer headers.
 */
export async function bulkVerifiedWorkers(ctx: Ctx, n: number): Promise<{ userId: string; auth: { authorization: string } }[]> {
  const out: { userId: string; auth: { authorization: string } }[] = [];
  await withTx(ctx.db, async (tx) => {
    for (let i = 0; i < n; i++) {
      const phone = fakePhone();
      const u = (await tx.query(
        `INSERT INTO users (phone_enc, phone_hash, phone_last4, kind) VALUES ($1, $2, $3, 'worker') RETURNING id`,
        [encrypt(phone, ctx.config.dataKey), lookupHash(phone, ctx.config.hashKey), phone.slice(-4)],
      )).rows[0];
      const pid = `bulk-${randomUUID()}`;
      await tx.query(
        `INSERT INTO worker_profiles (user_id, first_name, kyc_status, kyc_ref_hash, face_embedding, face_enrolled_at, languages, skills,
            travel_radius_km, home_city, home_point, profile_completed_at, verification_status)
         VALUES ($1, 'Bulk', 'verified', $2, $3, now(), '{hi}', '{packing,loading}', 25, 'BLR', ST_MakePoint(77.5946, 12.9716)::geography, now(), 'verified')`,
        [u.id, lookupHash(pid, ctx.config.hashKey), toPgVector(mockEmbedding(pid))],
      );
      const t = await createSession(tx, u.id, null);
      out.push({ userId: u.id, auth: { authorization: `Bearer ${t.accessToken}` } });
    }
  });
  return out;
}


