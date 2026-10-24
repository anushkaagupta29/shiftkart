import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app';
import type { Queryable } from '../db';
import { withTx } from '../db';
import { writeAudit } from '../audit';
import { getPolicies, getPolicy } from '../policy';
import { cancelLiveShift } from '../trust';
import { parse } from '../lib/validate';
import { HttpError, badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { userActor } from '../auth/guard';
import { requireMember } from './businesses';
import { computeShiftCost, meetsMinimumWage, minHourlyPaise, paidMinutes, resolveWageCategory, type WageCategory } from '../domain/shift-cost';
import { screenText } from '../domain/text-screen';
import { istDate } from '../time';

const bizAuth = { auth: { user: { kinds: ['business' as const] } } };
const BizParams = z.object({ businessId: z.string().uuid() }).strict();
const ShiftParams = z.object({ businessId: z.string().uuid(), shiftId: z.string().uuid() }).strict();
const LANG = z.enum(['en', 'hi', 'kn', 'ta', 'te', 'ml', 'mr', 'bn', 'ur']);
const paise = (max: number) => z.number().int().min(0).max(max);

// Requirements are structured choices only. There is no free-text requirement field (BIZ-07).
export const ShiftInput = z.object({
  siteId: z.string().uuid(),
  roleCode: z.string().max(40),
  title: z.string().trim().min(3).max(120),
  description: z.string().trim().max(2000).default(''),
  startsAt: z.string().datetime({ offset: true }),
  endsAt: z.string().datetime({ offset: true }),
  breakMinutes: z.number().int().min(0).max(120).default(0),
  headcount: z.number().int().min(1).max(500),
  payType: z.enum(['hourly', 'per_shift']),
  payPaise: paise(10_000_00).refine((v) => v > 0, 'Pay must be more than zero'),
  mealAllowancePaise: paise(1_000_00).default(0),
  travelAllowancePaise: paise(1_000_00).default(0),
  requirements: z.object({
    skills: z.array(z.string().max(40)).max(5).default([]),
    languages: z.array(LANG).max(5).default([]),
    twoWheeler: z.boolean().default(false),
  }).strict().prefault({}),
  dressCode: z.string().trim().max(300).default(''),
  bringItems: z.string().trim().max(300).default(''),
  onsiteContactMemberId: z.string().uuid().optional(),
  // Night shifts (state rules, SPEC §6.10): the business confirms safe transport home.
  nightTransportAttested: z.boolean().default(false),
  genderRequirement: z.object({
    requirement: z.enum(['female', 'male']),
    legalReason: z.string().trim().min(20, 'Explain the legal reason in at least 20 characters').max(1000),
  }).strict().optional(),
}).strict();
type ShiftInputT = z.infer<typeof ShiftInput>;

/** Validates a shift and prices it. Shared by preview and create, so the preview is exactly what gets charged. */
async function evaluateShift(db: Queryable, businessId: string, body: ShiftInputT) {
  const startsAt = new Date(body.startsAt);
  const endsAt = new Date(body.endsAt);
  if (startsAt.getUTCSeconds() || endsAt.getUTCSeconds() || startsAt.getUTCMilliseconds() || endsAt.getUTCMilliseconds()) {
    throw badRequest('whole_minutes', 'Start and end times must be whole minutes.');
  }
  if (endsAt <= startsAt) throw badRequest('bad_times', 'The shift must end after it starts.');
  if (endsAt.getTime() - startsAt.getTime() > 12 * 3600_000) throw badRequest('too_long', 'Shifts can be at most 12 hours.');
  if (startsAt.getTime() < Date.now() + 60 * 60_000) throw badRequest('too_soon', 'Shifts must start at least 1 hour from now.');
  if (startsAt.getTime() > Date.now() + 60 * 86400_000) throw badRequest('too_far', 'Shifts can be posted up to 60 days ahead.');
  let minutes: number;
  try { minutes = paidMinutes(startsAt, endsAt, body.breakMinutes); } catch { throw badRequest('bad_break', 'The break is longer than the shift.'); }

  const site = (await db.query('SELECT * FROM sites WHERE id = $1 AND business_id = $2', [body.siteId, businessId])).rows[0];
  if (!site) throw badRequest('unknown_site', 'Pick one of your own sites.');
  if (site.status !== 'active') throw badRequest('site_not_active', 'This site is not approved yet, or is paused.');

  const role = (await db.query('SELECT * FROM role_categories WHERE code = $1 AND active', [body.roleCode])).rows[0];
  if (!role) throw badRequest('unknown_role', 'Pick a role from the list.');
  const skills = body.requirements.skills.length
    ? (await db.query('SELECT code, min_wage_category FROM skills WHERE code = ANY($1)', [body.requirements.skills])).rows
    : [];
  if (skills.length !== new Set(body.requirements.skills).size) throw badRequest('unknown_skill', 'Pick skills from the list.');
  const category = resolveWageCategory(role.wage_category as WageCategory, skills.map((s) => s.min_wage_category as WageCategory));

  const shiftDate = istDate(startsAt);
  const rate = (await db.query(
    `SELECT * FROM min_wage_rates WHERE state_code = $1 AND wage_category = $2 AND zone = $3
        AND status = 'active' AND effective_from <= $4::date ORDER BY effective_from DESC LIMIT 1`,
    [site.state_code, category, site.wage_zone, shiftDate],
  )).rows[0];
  // Fail closed: with no confirmed rate we can't prove the pay is legal.
  if (!rate) throw new HttpError(422, 'no_wage_rate', 'No minimum wage rate is set up for this role and area yet. Contact support.');
  const r = { basicPaisePerDay: rate.basic_paise_per_day, vdaPaisePerDay: rate.vda_paise_per_day, standardHoursPerDay: rate.standard_hours_per_day };
  const minHourly = minHourlyPaise(r);
  if (!meetsMinimumWage(body.payType, body.payPaise, minutes, r)) {
    const err = new HttpError(422, 'below_minimum_wage', `Base pay is below the minimum wage (₹${(minHourly / 100).toFixed(2)}/hour for ${category.replace('_', '-')} work here). Allowances don't count toward it.`);
    err.issues = [{ path: 'payPaise', message: `minimum ${minHourly} paise per hour` }];
    throw err;
  }

  const pol = await getPolicies(db, ['fee.platform_bp', 'tax.gst_on_fee_bp']);
  const feeBp = pol['fee.platform_bp'], gstBp = pol['tax.gst_on_fee_bp'];
  // Welfare: the central rate is global; the state rate comes from the site's state (scope state:KA).
  const welfareCentralBp = await getPolicy<number>(db, 'welfare.central_bp');
  const welfareStateBp = (await getPolicies(db, ['welfare.state_bp'], `state:${site.state_code}`))['welfare.state_bp'];
  const cost = { ...computeShiftCost({ ...body, startsAt, endsAt, feeBp, gstBp, welfareCentralBp, welfareStateBp }), welfareState: site.state_code as string };

  // Night window from state rules (falls back to the national default).
  const nightPol = await getPolicies(db, ['night.start_min', 'night.end_min', 'night.transport_required'], `state:${site.state_code}`);
  const istMin = (d: Date) => { const x = new Date(d.getTime() + 330 * 60_000); return x.getUTCHours() * 60 + x.getUTCMinutes(); };
  const sMin = istMin(startsAt), eMin = istMin(endsAt);
  const crossesMidnight = endsAt.getTime() - startsAt.getTime() >= 24 * 3600_000 - 1 || eMin <= sMin;
  const inNight = (m: number) => m >= nightPol['night.start_min'] || m < nightPol['night.end_min'];
  const isNight = crossesMidnight || inNight(sMin) || inNight((eMin + 1439) % 1440);
  if (isNight && nightPol['night.transport_required'] && !body.nightTransportAttested) {
    throw badRequest('night_transport_required', 'This shift runs at night. Confirm you will arrange safe transport home for workers.');
  }

  const reviewReasons: string[] = screenText(body.title, body.description, body.dressCode, body.bringItems);
  const lateCancelFlag = await db.query(`SELECT 1 FROM fraud_flags WHERE subject_type = 'business' AND subject_id = $1 AND rule_code = 'late_cancel_pattern' AND status = 'open'`, [businessId]);
  if (lateCancelFlag.rowCount) reviewReasons.push('late_cancel_pattern');
  if (role.hazard_level === 'high') reviewReasons.push('high_hazard_role');
  if (body.genderRequirement) reviewReasons.push('gender_requirement');

  return { startsAt, endsAt, site, role, category, rate, minHourly, cost, reviewReasons, isNight };
}

async function checkNewBusinessLimits(db: Queryable, businessId: string, headcount: number, totalPaise: number) {
  const b = (await db.query('SELECT verified_at FROM businesses WHERE id = $1', [businessId])).rows[0];
  const newDays = await getPolicy<number>(db, 'business.new_days');
  if (b.verified_at && Date.now() - b.verified_at.getTime() > newDays * 86400_000) return;
  const pol = await getPolicies(db, ['business.new_max_headcount', 'business.new_max_outstanding_paise']);
  const maxHead = pol['business.new_max_headcount'], maxOutstanding = pol['business.new_max_outstanding_paise'];
  if (headcount > maxHead) throw conflict('new_business_headcount', `New businesses can post up to ${maxHead} people per shift for their first ${newDays} days.`);
  const out = (await db.query(
    `SELECT COALESCE(sum(total_paise), 0)::bigint AS s FROM shifts WHERE business_id = $1 AND status IN ('pending_review', 'pending_funding', 'live')`,
    [businessId],
  )).rows[0].s;
  if (out + totalPaise > maxOutstanding) throw conflict('new_business_exposure', `New businesses can have up to ₹${maxOutstanding / 100} of open shifts for their first ${newDays} days.`);
}

function shiftView(s: Record<string, any>) {
  return {
    id: s.id, siteId: s.site_id, siteName: s.site_name, roleCode: s.role_code, title: s.title, description: s.description,
    startsAt: s.starts_at, endsAt: s.ends_at, breakMinutes: s.break_minutes, headcount: s.headcount, filled: s.filled_count,
    payType: s.pay_type, payPaise: s.pay_paise, mealAllowancePaise: s.meal_allowance_paise, travelAllowancePaise: s.travel_allowance_paise,
    requirements: s.requirements, dressCode: s.dress_code, bringItems: s.bring_items, wageCategory: s.wage_category,
    cost: s.cost, totalPaise: s.total_paise, status: s.status, reviewReasons: s.review_reasons, publishedAt: s.published_at, createdAt: s.created_at,
  };
}

export async function shiftRoutes(app: FastifyInstance, { db, payouts, sms, config }: AppDeps) {
  const ensureCanPost = async (q: Queryable, businessId: string, userId: string) => {
    await requireMember(q, businessId, userId, ['owner', 'manager']);
    const b = (await q.query('SELECT verification_status FROM businesses WHERE id = $1', [businessId])).rows[0];
    // BIZ-01: unverified businesses can't post.
    if (b.verification_status !== 'verified') throw forbidden('Your business must be verified before you can post shifts.');
  };

  app.post('/businesses/:businessId/shifts/preview', { config: bizAuth }, async (req) => {
    const a = userActor(req);
    const { businessId } = parse(BizParams, req.params);
    const body = parse(ShiftInput, req.body);
    await ensureCanPost(db, businessId, a.userId);
    const e = await evaluateShift(db, businessId, body);
    return { cost: e.cost, wageCategory: e.category, minHourlyPaise: e.minHourly, needsReview: e.reviewReasons, isNight: e.isNight };
  });

  app.post('/businesses/:businessId/shifts', { config: bizAuth }, async (req, reply) => {
    const a = userActor(req);
    const { businessId } = parse(BizParams, req.params);
    const body = parse(ShiftInput, req.body);
    const shift = await withTx(db, async (tx) => {
      await ensureCanPost(tx, businessId, a.userId);
      if (body.onsiteContactMemberId) {
        const m = await tx.query('SELECT 1 FROM business_members WHERE id = $1 AND business_id = $2 AND removed_at IS NULL', [body.onsiteContactMemberId, businessId]);
        if (!m.rowCount) throw badRequest('unknown_contact', 'Pick an on-site contact from your team.');
      }
      const e = await evaluateShift(tx, businessId, body);
      await checkNewBusinessLimits(tx, businessId, body.headcount, e.cost.totalPaise);
      const status = e.reviewReasons.length ? 'pending_review' : 'pending_funding';
      const s = (await tx.query(
        `INSERT INTO shifts (business_id, site_id, role_code, title, description, starts_at, ends_at, break_minutes, headcount,
            pay_type, pay_paise, meal_allowance_paise, travel_allowance_paise, requirements, dress_code, bring_items,
            onsite_contact_member_id, wage_category, min_wage_rate_id, cost, total_paise, status, review_reasons, created_by, is_night, night_transport_attested)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26) RETURNING *`,
        [businessId, body.siteId, body.roleCode, body.title, body.description, e.startsAt, e.endsAt, body.breakMinutes, body.headcount,
         body.payType, body.payPaise, body.mealAllowancePaise, body.travelAllowancePaise, JSON.stringify(body.requirements),
         body.dressCode, body.bringItems, body.onsiteContactMemberId ?? null, e.category, e.rate.id, JSON.stringify(e.cost),
         e.cost.totalPaise, status, e.reviewReasons, a.userId, e.isNight, body.nightTransportAttested],
      )).rows[0];
      if (body.genderRequirement) {
        await tx.query(
          'INSERT INTO gender_requirements (shift_id, requirement, legal_reason, requested_by) VALUES ($1, $2, $3, $4)',
          [s.id, body.genderRequirement.requirement, body.genderRequirement.legalReason, a.userId],
        );
      }
      await writeAudit(tx, { actorType: 'user', actorId: a.userId, action: 'shift.create', targetType: 'shift', targetId: s.id, after: { status, totalPaise: e.cost.totalPaise, reviewReasons: e.reviewReasons }, ip: req.ip });
      return s;
    });
    reply.code(201);
    return shiftView(shift);
  });

  app.get('/businesses/:businessId/shifts', { config: bizAuth }, async (req) => {
    const a = userActor(req);
    const { businessId } = parse(BizParams, req.params);
    await requireMember(db, businessId, a.userId);
    const r = await db.query(
      `SELECT s.*, si.name AS site_name FROM shifts s JOIN sites si ON si.id = s.site_id
        WHERE s.business_id = $1 ORDER BY s.starts_at DESC LIMIT 200`,
      [businessId],
    );
    return r.rows.map(shiftView);
  });

  app.get('/businesses/:businessId/shifts/:shiftId', { config: bizAuth }, async (req) => {
    const a = userActor(req);
    const { businessId, shiftId } = parse(ShiftParams, req.params);
    await requireMember(db, businessId, a.userId);
    const s = (await db.query(
      `SELECT s.*, si.name AS site_name FROM shifts s JOIN sites si ON si.id = s.site_id WHERE s.id = $1 AND s.business_id = $2`,
      [shiftId, businessId],
    )).rows[0];
    if (!s) throw notFound();
    // BIZ-06: the business sees first names and booking status only. No phone, no photo, no home area.
    const roster = await db.query(
      `SELECT b.id, b.status, b.created_at, b.source, p.first_name, p.reliability_score
         FROM bookings b JOIN worker_profiles p ON p.user_id = b.worker_id
        WHERE b.shift_id = $1 ORDER BY b.created_at`,
      [shiftId],
    );
    const wl = await db.query(`SELECT count(*)::int AS n FROM waitlist_entries WHERE shift_id = $1 AND status IN ('waiting', 'offered')`, [shiftId]);
    const pay = await db.query(`SELECT id, status, amount_paise, created_at, captured_at FROM payment_intents WHERE shift_id = $1 ORDER BY created_at DESC`, [shiftId]);
    return {
      ...shiftView(s),
      roster: roster.rows.map((b) => ({ bookingId: b.id, firstName: b.first_name, status: b.status, source: b.source, bookedAt: b.created_at, reliability: b.reliability_score })),
      waitlisted: wl.rows[0].n,
      payments: pay.rows.map((p) => ({ id: p.id, status: p.status, amountPaise: p.amount_paise, createdAt: p.created_at, capturedAt: p.captured_at })),
    };
  });

  /**
   * Withdraw an unfunded shift (free), or cancel a live one: booked workers are compensated
   * automatically from escrow by how late it is, and the rest is refunded (SPEC §6.7).
   */
  app.post('/businesses/:businessId/shifts/:shiftId/cancel', { config: bizAuth }, async (req) => {
    const a = userActor(req);
    const { businessId, shiftId } = parse(ShiftParams, req.params);
    const { reason } = parse(z.object({ reason: z.string().trim().min(3).max(300) }).strict(), req.body);
    await requireMember(db, businessId, a.userId, ['owner', 'manager']);
    const unfunded = await withTx(db, async (tx) => {
      const r = await tx.query(
        `UPDATE shifts SET status = 'cancelled', cancelled_at = now(), cancel_reason = $3, cancelled_by = 'business'
          WHERE id = $1 AND business_id = $2 AND status IN ('pending_review', 'pending_funding') RETURNING id`,
        [shiftId, businessId, reason],
      );
      if (r.rowCount) await writeAudit(tx, { actorType: 'user', actorId: a.userId, action: 'shift.cancel_unfunded', targetType: 'shift', targetId: shiftId, reason, ip: req.ip });
      return Boolean(r.rowCount);
    });
    if (unfunded) return { ok: true, compensationPaise: 0 };
    const r = await cancelLiveShift(db, payouts, shiftId, { kind: 'business', userId: a.userId, businessId }, reason, { sms, dataKey: config.dataKey }, req.ip);
    return { ok: true, ...r };
  });

  /** What cancelling now would cost, shown before the business confirms. */
  app.get('/businesses/:businessId/shifts/:shiftId/cancel-preview', { config: bizAuth }, async (req) => {
    const a = userActor(req);
    const { businessId, shiftId } = parse(ShiftParams, req.params);
    await requireMember(db, businessId, a.userId);
    const s = (await db.query('SELECT * FROM shifts WHERE id = $1 AND business_id = $2', [shiftId, businessId])).rows[0];
    if (!s) throw notFound();
    const hoursBefore = (s.starts_at.getTime() - Date.now()) / 3600_000;
    const windows = (await getPolicy<{ beforeHours: number; workerCompBp: number }[]>(db, 'cancel.business.windows')).slice().sort((x, y) => y.beforeHours - x.beforeHours);
    const w = windows.find((x) => hoursBefore >= x.beforeHours) ?? windows[windows.length - 1]!;
    const booked = (await db.query(`SELECT count(*) FILTER (WHERE status = 'confirmed')::int AS c, count(*) FILTER (WHERE status = 'checked_in')::int AS i FROM bookings WHERE shift_id = $1`, [shiftId])).rows[0];
    return { hoursBefore: Math.round(hoursBefore * 10) / 10, compensationPercent: w.workerCompBp / 100, bookedWorkers: booked.c, checkedIn: booked.i, perWorkerPayPaise: Number(s.cost.perWorkerPayPaise) };
  });
}
