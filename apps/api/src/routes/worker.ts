import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { decrypt, encrypt, lookupHash } from '@shiftkart/shared';
import type { AppDeps } from '../app';
import type { Queryable } from '../db';
import { withTx } from '../db';
import { writeAudit } from '../audit';
import { raiseFlag } from '../fraud';
import { getPolicy } from '../policy';
import { parse } from '../lib/validate';
import { HttpError, badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { userActor } from '../auth/guard';
import { recomputeWorkerVerification } from '../worker-status';
import { cosineScore, fromPgVector, toPgVector } from '../adapters/mock-face';
import { nameMatchScore } from '../adapters/bank';
import { ageOn, istDate } from '../time';

const workerAuth = { auth: { user: { kinds: ['worker' as const] } } };
const LANG = z.enum(['en', 'hi', 'kn', 'ta', 'te', 'ml', 'mr', 'bn', 'ur']);

const Selfie = z.object({
  // In production this is a capture token from the liveness vendor's SDK. The mock takes who is
  // in front of the camera and whether it's a spoof (a printed photo, a screen).
  mockPersonId: z.string().min(1).max(100),
  mockSpoof: z.boolean().default(false),
}).strict();

const PayoutMethod = z.discriminatedUnion('type', [
  z.object({ type: z.literal('upi'), vpa: z.string().trim().toLowerCase().regex(/^[a-z0-9.\-_]{2,256}@[a-z]{2,64}$/, 'Enter a UPI ID like name@bank') }).strict(),
  z.object({
    type: z.literal('bank'),
    accountNo: z.string().trim().regex(/^\d{9,18}$/, 'Account number is 9-18 digits'),
    ifsc: z.string().trim().toUpperCase().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, 'Enter a valid IFSC'),
  }).strict(),
]);

const Profile = z.object({
  languages: z.array(LANG).min(1).max(9),
  skills: z.array(z.string().max(40)).min(1).max(10),
  travelRadiusKm: z.number().int().min(1).max(50),
  hasTwoWheeler: z.boolean(),
  homeCity: z.string().regex(/^[A-Z]{3}$/),
  homeLat: z.number().min(6).max(37).optional(),
  homeLng: z.number().min(68).max(98).optional(),
  availability: z.object({
    days: z.array(z.number().int().min(0).max(6)).max(7).default([]),
    from: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    to: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  }).strict().default({ days: [] }),
}).strict();

async function ensureProfile(db: Queryable, userId: string) {
  await db.query('INSERT INTO worker_profiles (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [userId]);
}

const maskVpa = (vpa: string) => { const [u, h] = vpa.split('@'); return `${u!.slice(0, 2)}****@${h}`; };

export async function workerRoutes(app: FastifyInstance, { db, config, kyc, liveness, bank }: AppDeps) {
  app.get('/worker/me', { config: workerAuth }, async (req) => {
    const a = userActor(req);
    await ensureProfile(db, a.userId);
    const p = (await db.query(
      `SELECT p.*, ST_Y(p.home_point::geometry) AS lat, ST_X(p.home_point::geometry) AS lng,
              (SELECT row_to_json(m) FROM (SELECT type, display, status, cooldown_until FROM payout_methods
                 WHERE worker_id = p.user_id AND status IN ('verified', 'review')) m) AS payout
         FROM worker_profiles p WHERE p.user_id = $1`,
      [a.userId],
    )).rows[0];
    return {
      firstName: p.first_name, verificationStatus: p.verification_status,
      steps: {
        identity: p.kyc_status, selfie: p.face_enrolled_at ? 'done' : 'todo',
        payout: p.payout?.status ?? 'todo', profile: p.profile_completed_at ? 'done' : 'todo',
      },
      kycRejectReason: p.kyc_reject_reason,
      payout: p.payout ? { type: p.payout.type, display: p.payout.display, status: p.payout.status, cooldownUntil: p.payout.cooldown_until } : null,
      profile: {
        languages: p.languages, skills: p.skills, travelRadiusKm: p.travel_radius_km, hasTwoWheeler: p.has_two_wheeler,
        homeCity: p.home_city, availability: p.availability, homeLat: p.lat, homeLng: p.lng,
      },
      completedShifts: p.completed_shifts, reliabilityScore: p.reliability_score,
      noFeesNotice: 'ShiftKart never asks workers for money. No registration fee, no deposit, ever.',
    };
  });

  app.post('/worker/kyc/start', { config: workerAuth }, async (req) => {
    const a = userActor(req);
    await ensureProfile(db, a.userId);
    const p = (await db.query('SELECT kyc_status FROM worker_profiles WHERE user_id = $1', [a.userId])).rows[0];
    if (p.kyc_status === 'verified') throw conflict('already_verified', 'Your identity is already verified.');
    if (p.kyc_status === 'rejected') throw forbidden('Identity verification was not successful. Contact support.');
    return kyc.start(a.userId);
  });

  app.post('/worker/kyc/complete', { config: workerAuth }, async (req) => {
    const a = userActor(req);
    const { sessionId } = parse(z.object({ sessionId: z.string().uuid() }).strict(), req.body);
    const result = await kyc.fetchResult(sessionId, a.userId);
    if (!result) throw conflict('kyc_pending', 'Finish the DigiLocker step first.');

    const age = ageOn(result.dob, istDate(new Date()));
    const outcome = await withTx(db, async (tx) => {
      await ensureProfile(tx, a.userId);
      const refHash = lookupHash(result.providerRef, config.hashKey);
      // WRK-06: age comes from the identity document, never from what the person types.
      if (age < 18) {
        await tx.query(
          `UPDATE worker_profiles SET kyc_status = 'rejected', kyc_reject_reason = 'underage', dob_year = $2 WHERE user_id = $1`,
          [a.userId, Number(result.dob.slice(0, 4))],
        );
        await writeAudit(tx, { actorType: 'system', action: 'worker.kyc_rejected_underage', targetType: 'user', targetId: a.userId });
        await recomputeWorkerVerification(tx, a.userId);
        return { error: new HttpError(403, 'underage', 'You must be 18 or older to work through ShiftKart.') };
      }
      // WRK-01 / WRK-07: one verified identity, one account.
      const other = await tx.query('SELECT user_id FROM worker_profiles WHERE kyc_ref_hash = $1 AND user_id <> $2', [refHash, a.userId]);
      if (other.rowCount) {
        await raiseFlag(tx, 'worker', a.userId, 'duplicate_identity', { otherUser: other.rows[0].user_id }, 90);
        await recomputeWorkerVerification(tx, a.userId);
        return { error: conflict('identity_already_registered', 'This identity is already linked to another ShiftKart account. Contact support.') };
      }
      const firstName = result.legalName.trim().split(/\s+/)[0]!;
      // Only the minimum: encrypted name, birth year, the provider reference (hashed) and a face template.
      // No Aadhaar number, no document image, no full date of birth (D-018).
      await tx.query(
        `UPDATE worker_profiles SET legal_name_enc = $2, first_name = $3, name_norm_hash = $4, dob_year = $5,
                age_verified_at = now(), kyc_status = 'verified', kyc_method = 'digilocker_mock', kyc_ref_hash = $6,
                face_embedding = $7, kyc_reject_reason = NULL
          WHERE user_id = $1`,
        [a.userId, encrypt(result.legalName, config.dataKey), firstName,
         lookupHash(result.legalName.toLowerCase().replace(/\s+/g, ' '), config.hashKey),
         Number(result.dob.slice(0, 4)), refHash, toPgVector(result.faceEmbedding)],
      );
      await writeAudit(tx, { actorType: 'user', actorId: a.userId, action: 'worker.kyc_verified', targetType: 'user', targetId: a.userId, ip: req.ip });
      return { ok: true, firstName, verificationStatus: await recomputeWorkerVerification(tx, a.userId) };
    });
    if ('error' in outcome) throw outcome.error;
    return outcome;
  });

  /** WRK-02: liveness + face match against the identity photo, then a duplicate-face search. */
  app.post('/worker/selfie', { config: workerAuth }, async (req) => {
    const a = userActor(req);
    const body = parse(Selfie, req.body);
    const p = (await db.query('SELECT kyc_status, face_embedding FROM worker_profiles WHERE user_id = $1', [a.userId])).rows[0];
    if (p?.kyc_status !== 'verified') throw conflict('kyc_first', 'Verify your identity first.');
    const check = await liveness.check(body);
    if (!check.live) throw badRequest('liveness_failed', 'We could not confirm a live selfie. Try again in good light, without glasses.');

    const [matchMin, dedupMin] = await Promise.all([getPolicy<number>(db, 'kyc.face_match_min'), getPolicy<number>(db, 'kyc.face_dedup_min')]);
    const score = cosineScore(fromPgVector(p.face_embedding), check.embedding);
    const outcome = await withTx(db, async (tx) => {
      if (score < matchMin) {
        await raiseFlag(tx, 'worker', a.userId, 'selfie_kyc_mismatch', { score }, 70);
        await recomputeWorkerVerification(tx, a.userId);
        return { error: badRequest('face_mismatch', 'The selfie does not match your ID photo. Our team will review it.') };
      }
      await tx.query('UPDATE worker_profiles SET face_enrolled_at = COALESCE(face_enrolled_at, now()), last_liveness_at = now() WHERE user_id = $1', [a.userId]);
      // WRK-01: the same face on another account (different ID documents) goes to review.
      const dupes = await tx.query(
        `SELECT user_id, round(((1 - (face_embedding <=> $2::vector)) * 100)::numeric) AS score FROM worker_profiles
          WHERE user_id <> $1 AND face_embedding IS NOT NULL AND (1 - (face_embedding <=> $2::vector)) * 100 >= $3
          ORDER BY face_embedding <=> $2::vector LIMIT 3`,
        [a.userId, toPgVector(check.embedding), dedupMin],
      );
      if (dupes.rowCount) {
        await raiseFlag(tx, 'worker', a.userId, 'duplicate_face', { matches: dupes.rows.map((d) => ({ user: d.user_id, score: Number(d.score) })) }, 90);
      }
      return { ok: true, matchScore: score, verificationStatus: await recomputeWorkerVerification(tx, a.userId) };
    });
    if ('error' in outcome) throw outcome.error;
    return outcome;
  });

  app.post('/worker/payout-method', { config: workerAuth }, async (req, reply) => {
    const a = userActor(req);
    const body = parse(PayoutMethod, req.body);
    const p = (await db.query('SELECT kyc_status, legal_name_enc, last_liveness_at FROM worker_profiles WHERE user_id = $1', [a.userId])).rows[0];
    if (p?.kyc_status !== 'verified') throw conflict('kyc_first', 'Verify your identity first.');
    const legalName = decrypt(p.legal_name_enc, config.dataKey);
    const normalized = body.type === 'upi' ? `upi:${body.vpa}` : `bank:${body.ifsc.slice(0, 4)}:${body.accountNo}`;
    const accountHash = lookupHash(normalized, config.hashKey);

    const check = await bank.verify(body.type === 'upi' ? { type: 'upi', vpa: body.vpa } : { type: 'bank', accountNo: body.accountNo, ifsc: body.ifsc }, legalName);
    if (!check.ok) throw badRequest('invalid_account', 'We could not find that account. Check the details.');
    const score = nameMatchScore(check.nameAtBank, legalName);
    const [verifyMin, reviewMin, cooldownH, livenessMaxMin] = await Promise.all([
      getPolicy<number>(db, 'payout.name_match_verify_min'), getPolicy<number>(db, 'payout.name_match_review_min'),
      getPolicy<number>(db, 'payout.change_cooldown_hours'), getPolicy<number>(db, 'payout.change_liveness_max_age_min'),
    ]);
    const display = body.type === 'upi' ? maskVpa(body.vpa) : `****${body.accountNo.slice(-4)} · ${body.ifsc}`;

    const outcome = await withTx(db, async (tx) => {
      await tx.query('SELECT 1 FROM worker_profiles WHERE user_id = $1 FOR UPDATE', [a.userId]);
      // WRK-01 / OFF-02: one bank account or UPI ID can't be shared by several workers.
      const shared = await tx.query(
        `SELECT worker_id FROM payout_methods WHERE account_hash = $1 AND worker_id <> $2 AND status IN ('verified', 'review')`,
        [accountHash, a.userId],
      );
      if (shared.rowCount) {
        await raiseFlag(tx, 'worker', a.userId, 'duplicate_account', { otherUser: shared.rows[0].worker_id }, 90);
        await raiseFlag(tx, 'worker', shared.rows[0].worker_id, 'duplicate_account', { otherUser: a.userId }, 90);
        await recomputeWorkerVerification(tx, a.userId);
        return { error: conflict('account_in_use', 'This account is linked to another worker. Use an account in your own name.') };
      }
      const current = (await tx.query(`SELECT id FROM payout_methods WHERE worker_id = $1 AND status IN ('verified', 'review')`, [a.userId])).rows[0];
      // MON-04 / ACC-01: changing where money goes needs a fresh live selfie and starts a cooldown.
      if (current) {
        const fresh = p.last_liveness_at && Date.now() - p.last_liveness_at.getTime() < livenessMaxMin * 60_000;
        if (!fresh) return { error: new HttpError(403, 'liveness_required', 'Take a quick selfie to confirm it is you, then change your account.') };
      }
      const status = score >= verifyMin ? 'verified' : score >= reviewMin ? 'review' : 'rejected';
      if (status !== 'rejected' && current) await tx.query(`UPDATE payout_methods SET status = 'replaced' WHERE id = $1`, [current.id]);
      const m = (await tx.query(
        `INSERT INTO payout_methods (worker_id, type, vpa_enc, account_no_enc, ifsc, account_hash, display, name_at_bank_enc, name_match_score, status, verified_at, cooldown_until)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, CASE WHEN $10 = 'verified' THEN now() END,
                 CASE WHEN $11 THEN now() + make_interval(hours => $12) END) RETURNING id, status, cooldown_until`,
        [a.userId, body.type, body.type === 'upi' ? encrypt(body.vpa, config.dataKey) : null,
         body.type === 'bank' ? encrypt(body.accountNo, config.dataKey) : null, body.type === 'bank' ? body.ifsc : null,
         accountHash, display, encrypt(check.nameAtBank, config.dataKey), score, status, Boolean(current) && status !== 'rejected', cooldownH],
      )).rows[0];
      await writeAudit(tx, { actorType: 'user', actorId: a.userId, action: current ? 'worker.payout_method_change' : 'worker.payout_method_add', targetType: 'user', targetId: a.userId, after: { status, nameMatch: score, display }, ip: req.ip });
      if (status === 'rejected') {
        return { error: badRequest('name_mismatch', 'The name on this account does not match your ID. Use an account in your own name.') };
      }
      if (status === 'review') await raiseFlag(tx, 'payout_method', m.id, 'payout_name_review', { score, worker: a.userId }, 40);
      return { id: m.id, status, display, cooldownUntil: m.cooldown_until, verificationStatus: await recomputeWorkerVerification(tx, a.userId) };
    });
    if ('error' in outcome) throw outcome.error;
    reply.code(201);
    return outcome;
  });

  app.put('/worker/profile', { config: workerAuth }, async (req) => {
    const a = userActor(req);
    const body = parse(Profile, req.body);
    const known = await db.query('SELECT code FROM skills WHERE code = ANY($1)', [body.skills]);
    if (known.rowCount !== new Set(body.skills).size) throw badRequest('unknown_skill', 'Pick skills from the list.');
    return withTx(db, async (tx) => {
      await ensureProfile(tx, a.userId);
      const city = (await tx.query(
        `SELECT code, ST_Y(center::geometry) AS lat, ST_X(center::geometry) AS lng,
                ($2::float IS NULL OR ST_DWithin(center, ST_MakePoint($3, $2)::geography, radius_km * 1000)) AS inside
           FROM cities WHERE code = $1`,
        [body.homeCity, body.homeLat ?? null, body.homeLng ?? null],
      )).rows[0];
      if (!city) throw badRequest('unknown_city', 'We are not live in that city yet.');
      if (!city.inside) throw badRequest('outside_city', 'That location is outside the selected city.');
      // Home area is kept coarse (about 1 km) and never shown to businesses.
      const lat = Math.round((body.homeLat ?? city.lat) * 100) / 100;
      const lng = Math.round((body.homeLng ?? city.lng) * 100) / 100;
      await tx.query(
        `UPDATE worker_profiles SET languages = $2, skills = $3, travel_radius_km = $4, has_two_wheeler = $5, home_city = $6,
                home_point = ST_MakePoint($7, $8)::geography, availability = $9, profile_completed_at = COALESCE(profile_completed_at, now())
          WHERE user_id = $1`,
        [a.userId, body.languages, [...new Set(body.skills)], body.travelRadiusKm, body.hasTwoWheeler, body.homeCity, lng, lat, JSON.stringify(body.availability)],
      );
      return { ok: true, verificationStatus: await recomputeWorkerVerification(tx, a.userId) };
    });
  });

  // Dev-only stand-in for the DigiLocker consent screen. The tester picks who they are.
  if (config.devEndpoints && config.env !== 'production') {
    app.post('/mock/digilocker/:sessionId/approve', { config: { auth: { public: true } } }, async (req) => {
      const { sessionId } = parse(z.object({ sessionId: z.string().uuid() }).strict(), req.params);
      const persona = parse(z.object({
        personId: z.string().min(1).max(100),
        name: z.string().trim().min(2).max(120),
        dob: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        // Lets tests model one face behind two different identity documents (WRK-01).
        faceId: z.string().min(1).max(100).optional(),
      }).strict(), req.body);
      const r = await db.query('UPDATE mock_kyc_sessions SET persona = $2 WHERE id = $1 AND consumed_at IS NULL RETURNING id', [sessionId, JSON.stringify(persona)]);
      if (!r.rowCount) throw notFound();
      return { ok: true };
    });

    // Lets the test build's "take selfie" button present the same face as the chosen test identity.
    app.get('/dev/my-face', { config: workerAuth }, async (req) => {
      const a = userActor(req);
      const r = await db.query(
        `SELECT persona FROM mock_kyc_sessions WHERE user_id = $1 AND consumed_at IS NOT NULL ORDER BY created_at DESC LIMIT 1`, [a.userId]);
      if (!r.rowCount) throw notFound();
      return { personId: r.rows[0].persona.faceId ?? r.rows[0].persona.personId };
    });
  }
}
