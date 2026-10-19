import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app';
import { withTx } from '../db';
import { writeAudit } from '../audit';
import { pagination, parse, reasonField, uuidParam } from '../lib/validate';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { staffActor } from '../auth/guard';
import { recomputeWorkerVerification } from '../worker-status';
import { istDate } from '../time';

export const OPS_ACCESS = {
  viewBusinesses: ['ops_verifier', 'ops_support', 'compliance'],
  reviewBusinesses: ['ops_verifier'],
  reviewSites: ['ops_verifier'],
  pauseSites: ['ops_safety'],
  viewShiftQueue: ['ops_verifier', 'compliance'],
  reviewShifts: ['ops_verifier', 'compliance'],
  viewFlags: ['ops_verifier', 'ops_safety', 'ops_disputes', 'compliance'],
  resolveFlags: ['ops_verifier', 'ops_safety', 'compliance'],
  viewRates: ['compliance', 'finance', 'ops_verifier'],
  manageRates: ['compliance'],
  managePolicy: ['compliance'],
  viewPayments: ['finance'],
} as const;
const roles = (k: keyof typeof OPS_ACCESS) => ({ auth: { staff: [...OPS_ACCESS[k]] } });

const Decision = z.object({ decision: z.enum(['approve', 'reject']), reason: reasonField }).strict();
const BizList = pagination.extend({ status: z.enum(['draft', 'pending', 'verified', 'rejected', 'suspended']).optional() }).strict();

export async function adminOpsRoutes(app: FastifyInstance, { db }: AppDeps) {
  // ---------------------------------------------------------------- businesses

  app.get('/admin/businesses', { config: roles('viewBusinesses') }, async (req) => {
    const q = parse(BizList, req.query);
    const r = await db.query(
      `SELECT b.*, count(*) OVER () AS total,
              (SELECT count(*) FROM business_reviews rv WHERE rv.business_id = b.id AND rv.round = b.review_round AND rv.decision = 'approve')::int AS approvals
         FROM businesses b WHERE ($1::text IS NULL OR verification_status = $1)
        ORDER BY submitted_at DESC NULLS LAST, created_at DESC LIMIT $2 OFFSET $3`,
      [q.status ?? null, q.pageSize, (q.page - 1) * q.pageSize],
    );
    return {
      total: r.rows[0]?.total ?? 0, page: q.page, pageSize: q.pageSize,
      items: r.rows.map((b) => ({
        id: b.id, legalName: b.legal_name, tradeName: b.trade_name, status: b.verification_status, riskTier: b.risk_tier,
        riskReasons: b.risk_reasons, submittedAt: b.submitted_at, approvals: b.approvals, approvalsNeeded: b.risk_tier === 'high' ? 2 : 1,
      })),
    };
  });

  app.get('/admin/businesses/:businessId', { config: roles('viewBusinesses') }, async (req) => {
    const { businessId } = parse(uuidParam('businessId'), req.params);
    const b = (await db.query('SELECT * FROM businesses WHERE id = $1', [businessId])).rows[0];
    if (!b) throw notFound();
    const [sites, reviews, flags, members] = await Promise.all([
      db.query(`SELECT id, name, address, city_code, geofence_m, status, status_reason, ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng FROM sites WHERE business_id = $1 ORDER BY created_at`, [businessId]),
      db.query(`SELECT rv.*, su.email FROM business_reviews rv JOIN staff_users su ON su.id = rv.staff_id WHERE business_id = $1 ORDER BY rv.created_at`, [businessId]),
      db.query(`SELECT id, rule_code, status, evidence, created_at FROM fraud_flags WHERE subject_type = 'business' AND subject_id = $1 ORDER BY created_at DESC`, [businessId]),
      db.query(`SELECT count(*)::int AS n FROM business_members WHERE business_id = $1 AND removed_at IS NULL`, [businessId]),
    ]);
    return {
      id: b.id, legalName: b.legal_name, tradeName: b.trade_name, status: b.verification_status, riskTier: b.risk_tier, riskReasons: b.risk_reasons,
      gstin: b.gstin, gstLegalName: b.gst_legal_name, panLast4: b.pan_last4, udyamOrSeNo: b.udyam_or_se_no, signatoryName: b.signatory_name,
      submittedAt: b.submitted_at, verifiedAt: b.verified_at, decisionReason: b.decision_reason, round: b.review_round, members: members.rows[0].n,
      sites: sites.rows.map((s) => ({ id: s.id, name: s.name, address: s.address, cityCode: s.city_code, geofenceM: s.geofence_m, status: s.status, statusReason: s.status_reason, lat: s.lat, lng: s.lng })),
      reviews: reviews.rows.map((r) => ({ staff: r.email, round: r.round, decision: r.decision, reason: r.reason, at: r.created_at })),
      flags: flags.rows.map((f) => ({ id: f.id, rule: f.rule_code, status: f.status, evidence: f.evidence, at: f.created_at })),
    };
  });

  /** High-risk businesses need two different verifiers to approve (INT-04). Any one reject ends the round. */
  app.post('/admin/businesses/:businessId/review', { config: roles('reviewBusinesses') }, async (req) => {
    const s = staffActor(req);
    const { businessId } = parse(uuidParam('businessId'), req.params);
    const { decision, reason } = parse(Decision, req.body);
    return withTx(db, async (tx) => {
      const b = (await tx.query('SELECT * FROM businesses WHERE id = $1 FOR UPDATE', [businessId])).rows[0];
      if (!b) throw notFound();
      if (b.verification_status !== 'pending') throw conflict('not_pending', 'This business is not waiting for review.');
      try {
        await tx.query('INSERT INTO business_reviews (business_id, staff_id, round, decision, reason) VALUES ($1, $2, $3, $4, $5)',
          [businessId, s.staffId, b.review_round, decision, reason]);
      } catch (e) {
        if ((e as { code?: string }).code === '23505') throw conflict('already_reviewed', 'You already reviewed this submission. A different verifier must give the second approval.');
        throw e;
      }
      let status = 'pending';
      if (decision === 'reject') status = 'rejected';
      else {
        const n = (await tx.query(`SELECT count(*)::int AS n FROM business_reviews WHERE business_id = $1 AND round = $2 AND decision = 'approve'`, [businessId, b.review_round])).rows[0].n;
        if (n >= (b.risk_tier === 'high' ? 2 : 1)) status = 'verified';
      }
      if (status !== 'pending') {
        await tx.query(
          `UPDATE businesses SET verification_status = $2, decision_reason = $3, verified_at = CASE WHEN $2 = 'verified' THEN now() ELSE verified_at END WHERE id = $1`,
          [businessId, status, reason],
        );
        if (status === 'verified') {
          await tx.query(`UPDATE sites SET status = 'active', verified_by = $2 WHERE business_id = $1 AND status = 'pending_verify'`, [businessId, s.staffId]);
        }
      }
      await writeAudit(tx, { actorType: 'staff', actorId: s.staffId, actorRoles: s.roles, action: `business.review_${decision}`, targetType: 'business', targetId: businessId, reason, before: { status: b.verification_status }, after: { status }, ip: req.ip });
      return { status };
    });
  });

  // ---------------------------------------------------------------- sites

  app.post('/admin/sites/:siteId/review', { config: roles('reviewSites') }, async (req) => {
    const s = staffActor(req);
    const { siteId } = parse(uuidParam('siteId'), req.params);
    const { decision, reason } = parse(Decision, req.body);
    return withTx(db, async (tx) => {
      const r = await tx.query(
        `UPDATE sites SET status = $2, status_reason = $3, verified_by = $4 WHERE id = $1 AND status = 'pending_verify' RETURNING business_id`,
        [siteId, decision === 'approve' ? 'active' : 'rejected', reason, s.staffId],
      );
      if (!r.rowCount) throw conflict('not_pending', 'This site is not waiting for review.');
      await writeAudit(tx, { actorType: 'staff', actorId: s.staffId, actorRoles: s.roles, action: `site.review_${decision}`, targetType: 'site', targetId: siteId, reason, ip: req.ip });
      return { status: decision === 'approve' ? 'active' : 'rejected' };
    });
  });

  for (const [action, from, to] of [['pause', 'active', 'paused'], ['resume', 'paused', 'active']] as const) {
    app.post(`/admin/sites/:siteId/${action}`, { config: roles('pauseSites') }, async (req) => {
      const s = staffActor(req);
      const { siteId } = parse(uuidParam('siteId'), req.params);
      const { reason } = parse(z.object({ reason: reasonField }).strict(), req.body);
      return withTx(db, async (tx) => {
        const r = await tx.query(`UPDATE sites SET status = $2, status_reason = $3 WHERE id = $1 AND status = $4 RETURNING id`, [siteId, to, reason, from]);
        if (!r.rowCount) throw conflict('bad_state', `Site is not ${from}.`);
        await writeAudit(tx, { actorType: 'staff', actorId: s.staffId, actorRoles: s.roles, action: `site.${action}`, targetType: 'site', targetId: siteId, reason, ip: req.ip });
        return { status: to };
      });
    });
  }

  // ---------------------------------------------------------------- shift review

  app.get('/admin/shifts/review', { config: roles('viewShiftQueue') }, async () => {
    const r = await db.query(
      `SELECT s.id, s.title, s.description, s.dress_code, s.bring_items, s.role_code, s.starts_at, s.headcount, s.review_reasons, s.created_at,
              b.legal_name, g.requirement AS gender_req, g.legal_reason AS gender_reason
         FROM shifts s JOIN businesses b ON b.id = s.business_id LEFT JOIN gender_requirements g ON g.shift_id = s.id
        WHERE s.status = 'pending_review' ORDER BY s.created_at LIMIT 100`,
    );
    return r.rows.map((s) => ({
      id: s.id, business: s.legal_name, title: s.title, description: s.description, dressCode: s.dress_code, bringItems: s.bring_items,
      roleCode: s.role_code, startsAt: s.starts_at, headcount: s.headcount, reasons: s.review_reasons, createdAt: s.created_at,
      genderRequirement: s.gender_req ? { requirement: s.gender_req, legalReason: s.gender_reason } : null,
    }));
  });

  app.post('/admin/shifts/:shiftId/review', { config: roles('reviewShifts') }, async (req) => {
    const s = staffActor(req);
    const { shiftId } = parse(uuidParam('shiftId'), req.params);
    const { decision, reason } = parse(Decision, req.body);
    return withTx(db, async (tx) => {
      const shift = (await tx.query('SELECT * FROM shifts WHERE id = $1 FOR UPDATE', [shiftId])).rows[0];
      if (!shift || shift.status !== 'pending_review') throw conflict('not_pending', 'This shift is not waiting for review.');
      const gender = (await tx.query('SELECT * FROM gender_requirements WHERE shift_id = $1', [shiftId])).rows[0];
      // Gender requirements are a legal judgement: compliance only, and logged (BIZ-07).
      if (gender && !s.roles.includes('compliance')) throw forbidden('Shifts with a gender requirement need a compliance officer.');
      if (gender) {
        await tx.query(`UPDATE gender_requirements SET status = $2, decided_by = $3, decided_at = now() WHERE id = $1`,
          [gender.id, decision === 'approve' ? 'approved' : 'rejected', s.staffId]);
      }
      const status = decision === 'approve' ? 'pending_funding' : 'cancelled';
      await tx.query(
        `UPDATE shifts SET status = $2, reviewed_by = $3, cancelled_at = CASE WHEN $2 = 'cancelled' THEN now() END,
                cancel_reason = CASE WHEN $2 = 'cancelled' THEN $4 END WHERE id = $1`,
        [shiftId, status, s.staffId, reason],
      );
      await writeAudit(tx, { actorType: 'staff', actorId: s.staffId, actorRoles: s.roles, action: `shift.review_${decision}`, targetType: 'shift', targetId: shiftId, reason, after: { status, gender: gender?.requirement ?? null }, ip: req.ip });
      return { status };
    });
  });

  // ---------------------------------------------------------------- fraud flags

  app.get('/admin/flags', { config: roles('viewFlags') }, async (req) => {
    const q = parse(pagination.extend({ status: z.enum(['open', 'confirmed', 'dismissed']).default('open') }).strict(), req.query);
    const r = await db.query(
      `SELECT *, count(*) OVER () AS total FROM fraud_flags WHERE status = $1 ORDER BY score DESC, created_at DESC LIMIT $2 OFFSET $3`,
      [q.status, q.pageSize, (q.page - 1) * q.pageSize],
    );
    return {
      total: r.rows[0]?.total ?? 0, page: q.page, pageSize: q.pageSize,
      items: r.rows.map((f) => ({ id: f.id, subjectType: f.subject_type, subjectId: f.subject_id, rule: f.rule_code, score: f.score, evidence: f.evidence, status: f.status, reviewReason: f.review_reason, createdAt: f.created_at })),
    };
  });

  app.post('/admin/flags/:flagId/resolve', { config: roles('resolveFlags') }, async (req) => {
    const s = staffActor(req);
    const { flagId } = parse(uuidParam('flagId'), req.params);
    const { decision, reason } = parse(z.object({ decision: z.enum(['confirmed', 'dismissed']), reason: reasonField }).strict(), req.body);
    return withTx(db, async (tx) => {
      const f = (await tx.query(
        `UPDATE fraud_flags SET status = $2, reviewer = $3, review_reason = $4, resolved_at = now() WHERE id = $1 AND status = 'open' RETURNING *`,
        [flagId, decision, s.staffId, reason],
      )).rows[0];
      if (!f) throw conflict('not_open', 'This flag is already resolved.');
      if (f.rule_code === 'payout_name_review') {
        await tx.query(`UPDATE payout_methods SET status = $2, verified_at = CASE WHEN $2 = 'verified' THEN now() END WHERE id = $1 AND status = 'review'`,
          [f.subject_id, decision === 'dismissed' ? 'verified' : 'rejected']);
        await recomputeWorkerVerification(tx, f.evidence.worker);
      }
      if (f.subject_type === 'worker') await recomputeWorkerVerification(tx, f.subject_id);
      await writeAudit(tx, { actorType: 'staff', actorId: s.staffId, actorRoles: s.roles, action: `flag.${decision}`, targetType: f.subject_type, targetId: f.subject_id, reason, after: { rule: f.rule_code }, ip: req.ip });
      return { status: decision };
    });
  });

  // ---------------------------------------------------------------- minimum wage rates (INT-06)

  app.get('/admin/wage-rates', { config: roles('viewRates') }, async () => {
    const r = await db.query(
      `SELECT w.*, c.email AS created_email, ap.email AS approved_email FROM min_wage_rates w
         LEFT JOIN staff_users c ON c.id = w.created_by LEFT JOIN staff_users ap ON ap.id = w.approved_by
        ORDER BY w.state_code, w.zone, w.wage_category, w.effective_from DESC`,
    );
    return r.rows.map((w) => ({
      id: w.id, stateCode: w.state_code, zone: w.zone, wageCategory: w.wage_category, basicPaisePerDay: w.basic_paise_per_day,
      vdaPaisePerDay: w.vda_paise_per_day, standardHoursPerDay: w.standard_hours_per_day, effectiveFrom: istDate(new Date(w.effective_from)),
      sourceRef: w.source_ref, status: w.status, createdBy: w.created_email, approvedBy: w.approved_email,
    }));
  });

  app.post('/admin/wage-rates', { config: roles('manageRates') }, async (req, reply) => {
    const s = staffActor(req);
    const body = parse(z.object({
      stateCode: z.string().regex(/^[A-Z]{2}$/), zone: z.string().min(1).max(10),
      wageCategory: z.enum(['unskilled', 'semi_skilled', 'skilled']),
      basicPaisePerDay: z.number().int().positive().max(1_000_000), vdaPaisePerDay: z.number().int().min(0).max(1_000_000),
      standardHoursPerDay: z.number().int().min(1).max(12).default(8),
      effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), sourceRef: z.string().trim().min(5).max(300), reason: reasonField,
    }).strict(), req.body);
    // No backdating: a lower rate can never apply to shifts already posted.
    if (body.effectiveFrom < istDate(new Date())) throw badRequest('backdated', 'Rates can only take effect from today or later.');
    return withTx(db, async (tx) => {
      const r = (await tx.query(
        `INSERT INTO min_wage_rates (state_code, wage_category, zone, basic_paise_per_day, vda_paise_per_day, standard_hours_per_day, effective_from, source_ref, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [body.stateCode, body.wageCategory, body.zone, body.basicPaisePerDay, body.vdaPaisePerDay, body.standardHoursPerDay, body.effectiveFrom, body.sourceRef, s.staffId],
      )).rows[0];
      await writeAudit(tx, { actorType: 'staff', actorId: s.staffId, actorRoles: s.roles, action: 'wage_rate.propose', targetType: 'min_wage_rate', targetId: r.id, reason: body.reason, after: body, ip: req.ip });
      reply.code(201);
      return { id: r.id, status: 'pending' };
    });
  });

  app.post('/admin/wage-rates/:rateId/decide', { config: roles('manageRates') }, async (req) => {
    const s = staffActor(req);
    const { rateId } = parse(uuidParam('rateId'), req.params);
    const { decision, reason } = parse(Decision, req.body);
    return withTx(db, async (tx) => {
      const w = (await tx.query('SELECT * FROM min_wage_rates WHERE id = $1 FOR UPDATE', [rateId])).rows[0];
      if (!w || w.status !== 'pending') throw conflict('not_pending', 'This rate is not waiting for a decision.');
      if (w.created_by === s.staffId) throw forbidden('A different compliance officer must approve this rate.');
      const status = decision === 'approve' ? 'active' : 'rejected';
      await tx.query('UPDATE min_wage_rates SET status = $2, approved_by = $3 WHERE id = $1', [rateId, status, s.staffId]);
      await writeAudit(tx, { actorType: 'staff', actorId: s.staffId, actorRoles: s.roles, action: `wage_rate.${decision}`, targetType: 'min_wage_rate', targetId: rateId, reason, ip: req.ip });
      return { status };
    });
  });

  // ---------------------------------------------------------------- policy changes (two-person)

  app.get('/admin/policy/requests', { config: roles('managePolicy') }, async () => {
    const r = await db.query(
      `SELECT p.*, a.email AS requested_email, d.email AS decided_email FROM policy_change_requests p
         JOIN staff_users a ON a.id = p.requested_by LEFT JOIN staff_users d ON d.id = p.decided_by ORDER BY p.created_at DESC LIMIT 100`,
    );
    return r.rows.map((p) => ({
      id: p.id, key: p.key, scope: p.scope, value: p.value, effectiveFrom: p.effective_from, reason: p.reason,
      requestedBy: p.requested_email, decision: p.decision, decidedBy: p.decided_email, decidedAt: p.decided_at,
    }));
  });

  app.post('/admin/policy/requests', { config: roles('managePolicy') }, async (req, reply) => {
    const s = staffActor(req);
    const body = parse(z.object({
      key: z.string().regex(/^[a-z0-9_.]+$/).max(80), scope: z.string().max(40).default('global'),
      value: z.unknown(), effectiveFrom: z.string().datetime({ offset: true }).optional(), reason: reasonField,
    }).strict(), req.body);
    const current = (await db.query(`SELECT value FROM policy_config WHERE key = $1 ORDER BY effective_from DESC LIMIT 1`, [body.key])).rows[0];
    if (!current) throw badRequest('unknown_key', 'That policy key does not exist.');
    const typeOf = (v: unknown) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);
    if (typeOf(current.value) !== typeOf(body.value)) throw badRequest('type_mismatch', `Value must be of type ${typeOf(current.value)}.`);
    const eff = body.effectiveFrom ? new Date(body.effectiveFrom) : new Date();
    if (eff.getTime() < Date.now() - 60_000) throw badRequest('backdated', 'Policy changes cannot be backdated.');
    return withTx(db, async (tx) => {
      const r = (await tx.query(
        `INSERT INTO policy_change_requests (key, scope, value, effective_from, reason, requested_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [body.key, body.scope, JSON.stringify(body.value), eff, body.reason, s.staffId],
      )).rows[0];
      await writeAudit(tx, { actorType: 'staff', actorId: s.staffId, actorRoles: s.roles, action: 'policy.request', targetType: 'policy', targetId: body.key, reason: body.reason, before: { value: current.value }, after: { value: body.value }, ip: req.ip });
      reply.code(201);
      return { id: r.id, status: 'pending' };
    });
  });

  app.post('/admin/policy/requests/:requestId/decide', { config: roles('managePolicy') }, async (req) => {
    const s = staffActor(req);
    const { requestId } = parse(uuidParam('requestId'), req.params);
    const { decision, reason } = parse(Decision, req.body);
    return withTx(db, async (tx) => {
      const p = (await tx.query('SELECT * FROM policy_change_requests WHERE id = $1 FOR UPDATE', [requestId])).rows[0];
      if (!p || p.decision) throw conflict('not_pending', 'This request is already decided.');
      if (p.requested_by === s.staffId) throw forbidden('A different compliance officer must approve this change.');
      await tx.query(`UPDATE policy_change_requests SET decision = $2, decided_by = $3, decided_at = now() WHERE id = $1`,
        [requestId, decision === 'approve' ? 'approved' : 'rejected', s.staffId]);
      if (decision === 'approve') {
        await tx.query(
          `INSERT INTO policy_config (key, scope, value, effective_from, changed_by, reason) VALUES ($1, $2, $3, GREATEST($4, now()), $5, $6)`,
          [p.key, p.scope, JSON.stringify(p.value), p.effective_from, p.requested_by, `${p.reason} (approved: ${reason})`],
        );
      }
      await writeAudit(tx, { actorType: 'staff', actorId: s.staffId, actorRoles: s.roles, action: `policy.${decision}`, targetType: 'policy', targetId: p.key, reason, after: { value: p.value }, ip: req.ip });
      return { status: decision === 'approve' ? 'approved' : 'rejected' };
    });
  });

  // ---------------------------------------------------------------- payments (read-only)

  app.get('/admin/payments', { config: roles('viewPayments') }, async (req) => {
    const q = parse(pagination.strict(), req.query);
    const r = await db.query(
      `SELECT p.*, b.legal_name, count(*) OVER () AS total FROM payment_intents p JOIN businesses b ON b.id = p.business_id
        ORDER BY p.created_at DESC LIMIT $1 OFFSET $2`,
      [q.pageSize, (q.page - 1) * q.pageSize],
    );
    return {
      total: r.rows[0]?.total ?? 0, page: q.page, pageSize: q.pageSize,
      items: r.rows.map((p) => ({ id: p.id, business: p.legal_name, shiftId: p.shift_id, amountPaise: p.amount_paise, status: p.status, orderRef: p.provider_ref, createdAt: p.created_at, capturedAt: p.captured_at })),
    };
  });

}
