import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { lookupHash } from '@shiftkart/shared';
import type { AppDeps } from '../app';
import { withTx } from '../db';
import { writeAudit } from '../audit';
import { raiseFlag } from '../fraud';
import { getPolicy } from '../policy';
import { parse } from '../lib/validate';
import { badRequest, conflict, notFound } from '../lib/errors';
import { userActor } from '../auth/guard';
import { requireMember } from './businesses';
import { nameMatchScore } from '../adapters/bank';
import { panFromGstin } from '../adapters/gstn';

const bizAuth = { auth: { user: { kinds: ['business' as const] } } };
const BizParams = z.object({ businessId: z.string().uuid() }).strict();

const NewSite = z.object({
  name: z.string().trim().min(2).max(120),
  address: z.string().trim().min(10).max(500),
  cityCode: z.string().regex(/^[A-Z]{3}$/),
  lat: z.number().min(6).max(37),
  lng: z.number().min(68).max(98),
  geofenceM: z.number().int().min(50).max(2000).optional(),
}).strict();

const Verification = z.object({
  gstin: z.string().trim().toUpperCase().regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, 'Not a valid GSTIN').optional(),
  udyamOrSeNo: z.string().trim().min(5).max(40).optional(),
  pan: z.string().trim().toUpperCase().regex(/^[A-Z]{5}\d{4}[A-Z]$/, 'Not a valid PAN'),
  signatoryName: z.string().trim().min(3).max(120),
}).strict().refine((v) => v.gstin || v.udyamOrSeNo, { message: 'Give a GSTIN or an Udyam / Shops & Establishments number' });

export async function businessOnboardingRoutes(app: FastifyInstance, { db, config, gstn }: AppDeps) {
  app.get('/reference', { config: { auth: { public: true } } }, async () => {
    const [cities, roles, skills] = await Promise.all([
      db.query('SELECT code, name, state_code, ST_Y(center::geometry) AS lat, ST_X(center::geometry) AS lng, radius_km FROM cities ORDER BY name'),
      db.query('SELECT code, name_i18n, wage_category, hazard_level, allowed_skills FROM role_categories WHERE active ORDER BY code'),
      db.query('SELECT code, name_i18n, min_wage_category FROM skills ORDER BY code'),
    ]);
    return {
      cities: cities.rows.map((c) => ({ code: c.code, name: c.name, stateCode: c.state_code, lat: c.lat, lng: c.lng, radiusKm: c.radius_km })),
      roles: roles.rows.map((r) => ({ code: r.code, name: r.name_i18n, wageCategory: r.wage_category, hazardLevel: r.hazard_level, skills: r.allowed_skills })),
      skills: skills.rows.map((s) => ({ code: s.code, name: s.name_i18n, minWageCategory: s.min_wage_category })),
      languages: ['en', 'hi', 'kn', 'ta', 'te', 'ml', 'mr', 'bn', 'ur'],
    };
  });

  app.get('/businesses/:businessId/sites', { config: bizAuth }, async (req) => {
    const a = userActor(req);
    const { businessId } = parse(BizParams, req.params);
    await requireMember(db, businessId, a.userId);
    const r = await db.query(
      `SELECT id, name, address, city_code, state_code, wage_zone, geofence_m, status, status_reason,
              ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng
         FROM sites WHERE business_id = $1 ORDER BY created_at`,
      [businessId],
    );
    return r.rows.map((s) => ({
      id: s.id, name: s.name, address: s.address, cityCode: s.city_code, stateCode: s.state_code, wageZone: s.wage_zone,
      geofenceM: s.geofence_m, status: s.status, statusReason: s.status_reason, lat: s.lat, lng: s.lng,
    }));
  });

  app.post('/businesses/:businessId/sites', { config: bizAuth }, async (req, reply) => {
    const a = userActor(req);
    const { businessId } = parse(BizParams, req.params);
    const body = parse(NewSite, req.body);
    const site = await withTx(db, async (tx) => {
      await requireMember(tx, businessId, a.userId, ['owner', 'manager']);
      const city = (await tx.query(
        `SELECT code, state_code, wage_zone, ST_DWithin(center, ST_MakePoint($2, $3)::geography, radius_km * 1000) AS inside
           FROM cities WHERE code = $1`,
        [body.cityCode, body.lng, body.lat],
      )).rows[0];
      if (!city) throw badRequest('unknown_city', 'We are not live in that city yet.');
      if (!city.inside) throw badRequest('outside_city', 'The map pin is outside the selected city.');
      const maxM = await getPolicy<number>(tx, 'geofence.max_m_without_approval');
      const geofence = body.geofenceM ?? (await getPolicy<number>(tx, 'geofence.default_m'));
      // Every new site is checked by ops before shifts can be posted there.
      const s = (await tx.query(
        `INSERT INTO sites (business_id, name, address, city_code, state_code, wage_zone, location, geofence_m, status_reason)
         VALUES ($1, $2, $3, $4, $5, $6, ST_MakePoint($7, $8)::geography, $9, $10) RETURNING id, status`,
        [businessId, body.name, body.address, city.code, city.state_code, city.wage_zone, body.lng, body.lat, geofence,
         geofence > maxM ? `Large geofence (${geofence} m) needs approval` : null],
      )).rows[0];
      await writeAudit(tx, { actorType: 'user', actorId: a.userId, action: 'site.create', targetType: 'site', targetId: s.id, after: { businessId, cityCode: city.code, geofence }, ip: req.ip });
      return s;
    });
    reply.code(201);
    return { id: site.id, status: site.status };
  });

  app.put('/businesses/:businessId/verification', { config: bizAuth }, async (req) => {
    const a = userActor(req);
    const { businessId } = parse(BizParams, req.params);
    const body = parse(Verification, req.body);
    if (body.gstin && panFromGstin(body.gstin) !== body.pan) throw badRequest('pan_gstin_mismatch', 'The PAN does not match the GSTIN.');
    const lookup = body.gstin ? await gstn.lookup(body.gstin) : null;

    const result = await withTx(db, async (tx) => {
      await requireMember(tx, businessId, a.userId, ['owner']);
      const b = (await tx.query('SELECT * FROM businesses WHERE id = $1 FOR UPDATE', [businessId])).rows[0];
      if (!['draft', 'rejected'].includes(b.verification_status)) throw conflict('already_submitted', 'Verification is already submitted.');
      const sites = await tx.query('SELECT count(*)::int AS n FROM sites WHERE business_id = $1', [businessId]);
      if (!sites.rows[0].n) throw badRequest('site_required', 'Add at least one work site first.');

      const reasons: string[] = [];
      if (!body.gstin) reasons.push('no_gstin');
      else if (!lookup?.found) reasons.push('gstin_not_found');
      else {
        if (lookup.status !== 'active') reasons.push('gstin_inactive');
        if (nameMatchScore(lookup.legalName, b.legal_name) < 80) reasons.push('gst_name_mismatch');
        if (body.gstin.slice(0, 2) !== '29') reasons.push('gstin_other_state'); // 29 = Karnataka
      }
      const tier = reasons.length ? 'high' : 'standard';
      try {
        await tx.query('SAVEPOINT gst');
        await tx.query(
          `UPDATE businesses SET gstin = $2, gst_legal_name = $3, gstin_checked_at = CASE WHEN $2::text IS NULL THEN NULL ELSE now() END,
                  pan_hash = $4, pan_last4 = $5, udyam_or_se_no = $6, signatory_name = $7, risk_tier = $8, risk_reasons = $9,
                  verification_status = 'pending', submitted_at = now(), review_round = review_round + 1, decision_reason = NULL
            WHERE id = $1`,
          [businessId, body.gstin ?? null, lookup?.found ? lookup.legalName : null, lookupHash(body.pan, config.hashKey),
           body.pan.slice(-4), body.udyamOrSeNo ?? null, body.signatoryName, tier, reasons],
        );
      } catch (e) {
        if ((e as { code?: string }).code !== '23505') throw e;
        // BIZ-04: someone else's GSTIN. Record it, then refuse.
        await tx.query('ROLLBACK TO SAVEPOINT gst');
        await raiseFlag(tx, 'business', businessId, 'gstin_in_use', { gstin: body.gstin }, 80);
        return { error: conflict('gstin_in_use', 'This GSTIN is already registered on ShiftKart. Contact support if this is your business.') };
      }
      await writeAudit(tx, { actorType: 'user', actorId: a.userId, action: 'business.submit_verification', targetType: 'business', targetId: businessId, after: { riskTier: tier, reasons }, ip: req.ip });
      return { status: 'pending', riskTier: tier, checks: reasons };
    });
    if ('error' in result) throw result.error;
    return result;
  });

  // Shown to the business so they know where they stand.
  app.get('/businesses/:businessId/verification', { config: bizAuth }, async (req) => {
    const a = userActor(req);
    const { businessId } = parse(BizParams, req.params);
    await requireMember(db, businessId, a.userId);
    const b = (await db.query('SELECT * FROM businesses WHERE id = $1', [businessId])).rows[0];
    if (!b) throw notFound();
    return {
      status: b.verification_status, gstin: b.gstin, panLast4: b.pan_last4, udyamOrSeNo: b.udyam_or_se_no,
      signatoryName: b.signatory_name, submittedAt: b.submitted_at, verifiedAt: b.verified_at, decisionReason: b.decision_reason,
    };
  });
}
