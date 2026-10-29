import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppDeps } from '../app';
import { writeAudit } from '../audit';
import { withTx } from '../db';
import { pagination, parse, reasonField } from '../lib/validate';
import { conflict, notFound } from '../lib/errors';
import { staffActor, userActor } from '../auth/guard';
import { requireMember } from './businesses';
import { appealStrike, decideAppeal, strikePoints, turnAway } from '../trust';
import { noticeRow, pendingNotice, respondToNotice } from '../removal';
import { blockBusiness, listMessages, rate, reportMessage, sendMessage, startCall, unblockBusiness, workerRating, type Party } from '../community';
import { addStatement, listCases, opsCaseAction, partyOpensCase, raiseSos, reportIncident, setTrustedContact, sharedLocation, sosLocation, viewCase } from '../cases';
import { listHires, offerHire, payHireFee, respondHire } from '../conversion';
import { normalizeIndianPhone } from '@shiftkart/shared';
import { badRequest } from '../lib/errors';

const workerAuth = { auth: { user: { kinds: ['worker' as const] } } };
const bizAuth = { auth: { user: { kinds: ['business' as const] } } };
const IdParam = z.object({ id: z.string().uuid() }).strict();
const NoticeResponse = z.object({ response: z.string().trim().min(10).max(2000) }).strict();
const BizIdParam = z.object({ businessId: z.string().uuid(), id: z.string().uuid() }).strict();
const BizParam = z.object({ businessId: z.string().uuid() }).strict();
const Rating = z.object({
  stars: z.number().int().min(1).max(5),
  tags: z.array(z.enum(['on_time', 'hard_working', 'friendly', 'skilled', 'late', 'rude', 'left_early', 'unsafe_site', 'paid_fairly', 'respectful', 'disorganised', 'clear_instructions'])).max(5).default([]),
  comment: z.string().trim().max(500).default(''),
}).strict();
const Loc = { lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), accuracyM: z.number().int().min(0).max(100_000) };
const INCIDENT = z.enum(['harassment', 'unsafe_site', 'injury', 'payment_demand', 'discrimination', 'work_mismatch', 'underage_worker', 'other']);

const workerParty = (req: FastifyRequest): Party => ({ kind: 'worker', userId: userActor(req).userId });

export async function trustRoutes(app: FastifyInstance, { db, sms, config }: AppDeps) {
  const notify = { sms, dataKey: config.dataKey };
  const bizParty = async (req: FastifyRequest, businessId: string, roles?: ('owner' | 'manager' | 'supervisor')[]): Promise<Party> => {
    const a = userActor(req);
    await requireMember(db, businessId, a.userId, roles);
    return { kind: 'business', userId: a.userId, businessId };
  };

  // ---------------------------------------------------------------- strikes (worker)

  app.get('/worker/strikes', { config: workerAuth }, async (req) => {
    const a = userActor(req);
    const r = await db.query(
      `SELECT k.*, s.title FROM strikes k JOIN bookings b ON b.id = k.booking_id JOIN shifts s ON s.id = b.shift_id WHERE k.worker_id = $1 ORDER BY k.created_at DESC`, [a.userId]);
    const level = await strikePoints(db, a.userId);
    const rating = await workerRating(db, a.userId);
    return {
      ...level, rating,
      items: r.rows.map((k) => ({ id: k.id, kind: k.kind, points: k.points, status: k.status, emergency: k.emergency, shiftTitle: k.title, hoursBefore: k.hours_before ? Number(k.hours_before) : null, expiresAt: k.expires_at, appealReason: k.appeal_reason, decisionReason: k.decision_reason, at: k.created_at })),
    };
  });

  // ---------------------------------------------------------------- removal notice (worker, D-091)

  app.get('/worker/removal-notice', { config: workerAuth }, async (req) => {
    const n = await pendingNotice(db, userActor(req).userId);
    return { notice: n ? noticeRow(n) : null };
  });

  app.post('/worker/removal-notice/:id/respond', { config: workerAuth }, async (req) => {
    const { id } = parse(IdParam, req.params);
    const { response } = parse(NoticeResponse, req.body);
    return respondToNotice(db, userActor(req).userId, id, response);
  });

  app.post('/worker/strikes/:id/appeal', { config: workerAuth }, async (req) => {
    const { id } = parse(IdParam, req.params);
    const { reason } = parse(z.object({ reason: z.string().trim().min(10).max(1000) }).strict(), req.body);
    return appealStrike(db, userActor(req).userId, id, reason);
  });

  // ---------------------------------------------------------------- ratings

  app.post('/worker/bookings/:id/rating', { config: workerAuth }, async (req) => {
    const { id } = parse(IdParam, req.params);
    return rate(db, workerParty(req), id, parse(Rating, req.body));
  });

  app.post('/businesses/:businessId/bookings/:id/rating', { config: bizAuth }, async (req) => {
    const { businessId, id } = parse(BizIdParam, req.params);
    return rate(db, await bizParty(req, businessId, ['owner', 'manager', 'supervisor']), id, parse(Rating, req.body));
  });

  // ---------------------------------------------------------------- chat, calls, blocks

  app.get('/worker/bookings/:id/chat', { config: workerAuth }, async (req) => listMessages(db, workerParty(req), parse(IdParam, req.params).id));
  app.post('/worker/bookings/:id/chat', { config: workerAuth }, async (req) => {
    const { id } = parse(IdParam, req.params);
    const { text } = parse(z.object({ text: z.string().max(2000) }).strict(), req.body);
    return sendMessage(db, workerParty(req), id, text, config.dataKey);
  });
  app.post('/worker/bookings/:id/call', { config: workerAuth }, async (req) => startCall(db, workerParty(req), parse(IdParam, req.params).id));
  app.post('/worker/messages/:id/report', { config: workerAuth }, async (req) => {
    const { id } = parse(IdParam, req.params);
    const { reason } = parse(z.object({ reason: z.string().trim().min(3).max(300) }).strict(), req.body);
    return reportMessage(db, workerParty(req), id, reason);
  });
  app.post('/worker/blocks/:id', { config: workerAuth }, async (req) => {
    const { id } = parse(IdParam, req.params);
    const { reason } = parse(z.object({ reason: z.string().trim().max(300).optional() }).strict(), req.body ?? {});
    return blockBusiness(db, userActor(req).userId, id, reason);
  });
  app.delete('/worker/blocks/:id', { config: workerAuth }, async (req) => unblockBusiness(db, userActor(req).userId, parse(IdParam, req.params).id));

  app.get('/businesses/:businessId/bookings/:id/chat', { config: bizAuth }, async (req) => {
    const { businessId, id } = parse(BizIdParam, req.params);
    return listMessages(db, await bizParty(req, businessId), id);
  });
  app.post('/businesses/:businessId/bookings/:id/chat', { config: bizAuth }, async (req) => {
    const { businessId, id } = parse(BizIdParam, req.params);
    const { text } = parse(z.object({ text: z.string().max(2000) }).strict(), req.body);
    return sendMessage(db, await bizParty(req, businessId), id, text, config.dataKey);
  });
  app.post('/businesses/:businessId/bookings/:id/call', { config: bizAuth }, async (req) => {
    const { businessId, id } = parse(BizIdParam, req.params);
    return startCall(db, await bizParty(req, businessId), id);
  });
  app.post('/businesses/:businessId/messages/:id/report', { config: bizAuth }, async (req) => {
    const { businessId, id } = parse(BizIdParam, req.params);
    const { reason } = parse(z.object({ reason: z.string().trim().min(3).max(300) }).strict(), req.body);
    return reportMessage(db, await bizParty(req, businessId), id, reason);
  });

  // ---------------------------------------------------------------- turn-away (PAY-11)

  app.post('/businesses/:businessId/bookings/:id/turn-away', { config: bizAuth }, async (req) => {
    const { businessId, id } = parse(BizIdParam, req.params);
    const { reason } = parse(z.object({ reason: z.string().trim().min(5).max(300) }).strict(), req.body);
    const p = await bizParty(req, businessId, ['owner', 'manager', 'supervisor']);
    return turnAway(db, { businessId, userId: p.userId }, id, reason, notify, req.ip);
  });

  // ---------------------------------------------------------------- disputes

  const OpenCase = z.object({ bookingId: z.string().uuid(), kind: z.enum(['cancellation', 'payment', 'rating', 'conduct', 'other']), summary: z.string().trim().min(10).max(2000) }).strict();
  const Statement = z.object({ body: z.string().trim().min(2).max(2000) }).strict();

  app.get('/worker/disputes', { config: workerAuth }, async (req) => listCases(db, workerParty(req)));
  app.post('/worker/disputes', { config: workerAuth }, async (req, reply) => { reply.code(201); return partyOpensCase(db, workerParty(req), parse(OpenCase, req.body)); });
  app.get('/worker/disputes/:id', { config: workerAuth }, async (req) => viewCase(db, workerParty(req), parse(IdParam, req.params).id));
  app.post('/worker/disputes/:id/statements', { config: workerAuth }, async (req) => addStatement(db, workerParty(req), parse(IdParam, req.params).id, parse(Statement, req.body).body));

  app.get('/businesses/:businessId/disputes', { config: bizAuth }, async (req) => listCases(db, await bizParty(req, parse(BizParam, req.params).businessId)));
  app.post('/businesses/:businessId/disputes', { config: bizAuth }, async (req, reply) => {
    const { businessId } = parse(BizParam, req.params);
    reply.code(201);
    return partyOpensCase(db, await bizParty(req, businessId, ['owner', 'manager']), parse(OpenCase, req.body));
  });
  app.get('/businesses/:businessId/disputes/:id', { config: bizAuth }, async (req) => {
    const { businessId, id } = parse(BizIdParam, req.params);
    return viewCase(db, await bizParty(req, businessId), id);
  });
  app.post('/businesses/:businessId/disputes/:id/statements', { config: bizAuth }, async (req) => {
    const { businessId, id } = parse(BizIdParam, req.params);
    return addStatement(db, await bizParty(req, businessId, ['owner', 'manager']), id, parse(Statement, req.body).body);
  });

  // ---------------------------------------------------------------- safety

  app.put('/worker/trusted-contact', { config: workerAuth }, async (req) => {
    const body = parse(z.object({ name: z.string().trim().min(2).max(80), phone: z.string().max(20) }).strict(), req.body);
    const phone = normalizeIndianPhone(body.phone);
    if (!phone) throw badRequest('invalid_phone', 'Enter an Indian mobile number.');
    return setTrustedContact(db, userActor(req).userId, body.name, phone, config.dataKey);
  });

  app.post('/worker/sos', { config: workerAuth }, async (req, reply) => {
    const body = parse(z.object({ bookingId: z.string().uuid().optional(), ...Loc, shareWithContact: z.boolean().default(false) }).strict(), req.body);
    reply.code(201);
    return raiseSos(db, userActor(req).userId, body, { ...notify, publicBaseUrl: config.publicApiUrl });
  });
  app.post('/worker/sos/:id/location', { config: workerAuth }, async (req) => {
    const { id } = parse(IdParam, req.params);
    return sosLocation(db, userActor(req).userId, id, parse(z.object(Loc).strict(), req.body));
  });

  /** The trusted contact's page. No login: the unguessable link is the key, and it expires. */
  app.get('/safety/share/:token', { config: { auth: { public: true } } }, async (req, reply) => {
    const { token } = parse(z.object({ token: z.string().min(20).max(100) }).strict(), req.params);
    const s = await sharedLocation(db, token);
    reply.header('cache-control', 'no-store').header('referrer-policy', 'no-referrer').type('text/html; charset=utf-8');
    if (!s) return `<!doctype html><meta name="viewport" content="width=device-width"><title>ShiftKart safety</title><body style="font-family:system-ui;padding:24px"><h2>This link has expired.</h2><p>If you are worried, call 112.</p>`;
    const esc = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
    const l = s.location;
    return `<!doctype html><meta name="viewport" content="width=device-width"><meta http-equiv="refresh" content="30"><title>ShiftKart safety</title>
<body style="font-family:system-ui;padding:24px;max-width:560px">
<h2>${esc(s.firstName ?? 'Your contact')} pressed SOS</h2>
<p>Status: <b>${esc(s.status)}</b>. ShiftKart's safety team has been alerted.</p>
${l ? `<p>Last location ${esc(new Date(l.at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }))} IST (±${l.accuracy_m ?? '?'} m):<br>
<a href="https://www.openstreetmap.org/?mlat=${l.lat}&mlon=${l.lng}#map=17/${l.lat}/${l.lng}">Open map</a></p>` : ''}
<p>This page refreshes every 30 seconds and stops working at ${esc(new Date(s.expiresAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }))} IST. In an emergency call <b>112</b>.</p>`;
  });

  const Incident = z.object({ category: INCIDENT, description: z.string().trim().min(10).max(4000), bookingId: z.string().uuid().optional(), anonymous: z.boolean().default(false) }).strict();
  app.post('/worker/incidents', { config: workerAuth }, async (req, reply) => { reply.code(201); return reportIncident(db, workerParty(req), parse(Incident, req.body)); });
  app.post('/businesses/:businessId/incidents', { config: bizAuth }, async (req, reply) => {
    const { businessId } = parse(BizParam, req.params);
    reply.code(201);
    return reportIncident(db, await bizParty(req, businessId), parse(Incident, req.body));
  });
  /** BIZ-05: "the work wasn't what was posted". */
  app.post('/worker/bookings/:id/report-mismatch', { config: workerAuth }, async (req, reply) => {
    const { id } = parse(IdParam, req.params);
    const { details } = parse(z.object({ details: z.string().trim().min(10).max(2000) }).strict(), req.body);
    reply.code(201);
    return reportIncident(db, workerParty(req), { category: 'work_mismatch', description: details, bookingId: id, anonymous: false });
  });

  // ---------------------------------------------------------------- full-time hire (OFF-01)

  app.post('/businesses/:businessId/hire-requests', { config: bizAuth }, async (req, reply) => {
    const { businessId } = parse(BizParam, req.params);
    const body = parse(z.object({ bookingId: z.string().uuid(), roleTitle: z.string().trim().min(3).max(120), monthlySalaryPaise: z.number().int().positive().max(100_000_000).optional(), message: z.string().trim().max(500).optional() }).strict(), req.body);
    const p = await bizParty(req, businessId, ['owner', 'manager']);
    reply.code(201);
    return offerHire(db, { businessId, userId: p.userId }, body, notify);
  });
  app.get('/businesses/:businessId/hire-requests', { config: bizAuth }, async (req) => {
    const { businessId } = parse(BizParam, req.params);
    await bizParty(req, businessId, ['owner', 'manager']);
    return listHires(db, { businessId }, config.dataKey);
  });
  app.post('/businesses/:businessId/hire-requests/:id/pay', { config: bizAuth }, async (req) => {
    const { businessId, id } = parse(BizIdParam, req.params);
    const p = await bizParty(req, businessId, ['owner', 'manager']);
    return payHireFee(db, { businessId, userId: p.userId }, id);
  });
  app.get('/worker/hire-requests', { config: workerAuth }, async (req) => listHires(db, { workerId: userActor(req).userId }, config.dataKey));
  for (const action of ['accept', 'decline'] as const) {
    app.post(`/worker/hire-requests/:id/${action}`, { config: workerAuth }, async (req) => respondHire(db, userActor(req).userId, parse(IdParam, req.params).id, action === 'accept'));
  }

  // ---------------------------------------------------------------- admin

  const disputesStaff = { auth: { staff: ['ops_disputes' as const] } };
  const safetyStaff = { auth: { staff: ['ops_safety' as const] } };

  app.get('/admin/appeals', { config: { auth: { staff: ['ops_disputes', 'ops_support'] } } }, async () => {
    const r = await db.query(
      `SELECT k.*, p.first_name, s.title, s.starts_at FROM strikes k JOIN worker_profiles p ON p.user_id = k.worker_id
         JOIN bookings b ON b.id = k.booking_id JOIN shifts s ON s.id = b.shift_id WHERE k.status = 'appealed' ORDER BY k.appealed_at`);
    return r.rows.map((k) => ({ id: k.id, workerId: k.worker_id, firstName: k.first_name, kind: k.kind, points: k.points, emergency: k.emergency, shiftTitle: k.title, shiftStart: k.starts_at, hoursBefore: k.hours_before ? Number(k.hours_before) : null, appealReason: k.appeal_reason, appealedAt: k.appealed_at }));
  });
  app.post('/admin/appeals/:id/decide', { config: disputesStaff }, async (req) => {
    const { id } = parse(IdParam, req.params);
    const { decision, reason } = parse(z.object({ decision: z.enum(['overturn', 'uphold']), reason: reasonField }).strict(), req.body);
    return decideAppeal(db, staffActor(req), id, decision === 'overturn', reason, notify, req.ip);
  });

  app.get('/admin/disputes', { config: disputesStaff }, async (req) => {
    const q = parse(pagination.extend({ status: z.enum(['open', 'under_review', 'decided', 'withdrawn']).optional() }).strict(), req.query);
    const r = await db.query(
      `SELECT c.*, p.first_name, b.legal_name, count(*) OVER () AS total FROM dispute_cases c
         JOIN worker_profiles p ON p.user_id = c.worker_id JOIN businesses b ON b.id = c.business_id
        WHERE ($1::text IS NULL OR c.status = $1) ORDER BY c.decide_due_at LIMIT $2 OFFSET $3`,
      [q.status ?? null, q.pageSize, (q.page - 1) * q.pageSize],
    );
    return {
      total: r.rows[0]?.total ?? 0,
      items: r.rows.map((c) => ({ id: c.id, kind: c.kind, status: c.status, summary: c.summary, worker: c.first_name, business: c.legal_name, openedBy: c.opened_by, ackDueAt: c.ack_due_at, decideDueAt: c.decide_due_at, overdue: c.status !== 'decided' && c.decide_due_at < new Date(), timesheetId: c.timesheet_id })),
    };
  });
  app.get('/admin/disputes/:id', { config: disputesStaff }, async (req) => {
    const { id } = parse(IdParam, req.params);
    const c = (await db.query('SELECT * FROM dispute_cases WHERE id = $1', [id])).rows[0];
    if (!c) throw notFound();
    const [events, attendance, chat, ratings] = await Promise.all([
      db.query(`SELECT actor_type, type, body, internal, created_at FROM dispute_events WHERE case_id = $1 ORDER BY created_at`, [id]),
      c.booking_id ? db.query(`SELECT type, mode, status, effective_at, distance_m, face_score, flags FROM attendance_events WHERE booking_id = $1 ORDER BY effective_at`, [c.booking_id]) : { rows: [] },
      c.booking_id ? db.query(`SELECT m.sender_type, m.body, m.flags, m.status, m.created_at FROM messages m JOIN conversations v ON v.id = m.conversation_id WHERE v.booking_id = $1 ORDER BY m.created_at`, [c.booking_id]) : { rows: [] },
      c.booking_id ? db.query(`SELECT rater_type, stars, tags, comment FROM ratings WHERE booking_id = $1`, [c.booking_id]) : { rows: [] },
    ]);
    return { ...c, timeline: events.rows, evidence: { attendance: attendance.rows, chat: chat.rows, ratings: ratings.rows } };
  });
  app.post('/admin/disputes/:id/action', { config: disputesStaff }, async (req) => {
    const { id } = parse(IdParam, req.params);
    const action = parse(z.discriminatedUnion('type', [
      z.object({ type: z.literal('acknowledge') }).strict(),
      z.object({ type: z.literal('note'), body: z.string().trim().min(2).max(2000) }).strict(),
      z.object({ type: z.literal('message'), body: z.string().trim().min(2).max(2000) }).strict(),
      z.object({ type: z.literal('decide'), decision: z.string().trim().min(3).max(300), reason: reasonField }).strict(),
    ]), req.body);
    return opsCaseAction(db, staffActor(req), id, action, req.ip);
  });

  app.get('/admin/safety', { config: safetyStaff }, async () => {
    const sos = await db.query(
      `SELECT e.*, p.first_name, (SELECT row_to_json(l) FROM (SELECT lat, lng, accuracy_m, at FROM sos_locations WHERE sos_id = e.id ORDER BY at DESC LIMIT 1) l) AS last
         FROM sos_events e JOIN worker_profiles p ON p.user_id = e.worker_id WHERE e.status <> 'resolved' ORDER BY e.created_at DESC`);
    const incidents = await db.query(
      `SELECT i.*, b.legal_name FROM incidents i LEFT JOIN businesses b ON b.id = i.business_id WHERE i.status <> 'closed'
        ORDER BY CASE i.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END, i.created_at DESC`);
    return {
      sos: sos.rows.map((e) => ({ id: e.id, workerId: e.worker_id, firstName: e.first_name, bookingId: e.booking_id, status: e.status, sharedWithContact: Boolean(e.share_token_hash), last: e.last, at: e.created_at })),
      incidents: incidents.rows.map((i) => ({ id: i.id, category: i.category, severity: i.severity, status: i.status, anonymous: i.reporter_type === 'anonymous', reporterType: i.reporter_type, business: i.legal_name, businessId: i.business_id, siteId: i.site_id, description: i.description, at: i.created_at })),
    };
  });
  for (const [action, to] of [['acknowledge', 'acknowledged'], ['resolve', 'resolved']] as const) {
    app.post(`/admin/sos/:id/${action}`, { config: safetyStaff }, async (req) => {
      const s = staffActor(req);
      const { id } = parse(IdParam, req.params);
      const { note } = parse(z.object({ note: z.string().trim().min(3).max(1000) }).strict(), req.body);
      return withTx(db, async (tx) => {
        const r = await tx.query(
          `UPDATE sos_events SET status = $2, ${to === 'acknowledged' ? 'acknowledged_by = $3, acknowledged_at = now()' : 'resolved_by = $3, resolved_at = now(), resolution = $4, share_expires_at = LEAST(share_expires_at, now())'} WHERE id = $1 AND status <> 'resolved' RETURNING id`,
          to === 'acknowledged' ? [id, to, s.staffId] : [id, to, s.staffId, note],
        );
        if (!r.rowCount) throw conflict('closed', 'Already resolved.');
        if (to === 'resolved') await tx.query(`UPDATE fraud_flags SET status = 'dismissed', reviewer = $2, review_reason = $3, resolved_at = now() WHERE subject_id = $1 AND status = 'open'`, [`sos:${id}`, s.staffId, note]);
        await writeAudit(tx, { actorType: 'staff', actorId: s.staffId, actorRoles: s.roles, action: `sos.${action}`, targetType: 'sos', targetId: id, reason: note, ip: req.ip });
        return { status: to };
      });
    });
  }
  app.post('/admin/incidents/:id', { config: safetyStaff }, async (req) => {
    const s = staffActor(req);
    const { id } = parse(IdParam, req.params);
    const body = parse(z.object({ status: z.enum(['in_progress', 'closed']), outcome: z.string().trim().min(5).max(2000) }).strict(), req.body);
    return withTx(db, async (tx) => {
      const r = await tx.query(`UPDATE incidents SET status = $2, outcome = $3, assigned_to = $4 WHERE id = $1 RETURNING id`, [id, body.status, body.outcome, s.staffId]);
      if (!r.rowCount) throw notFound();
      await writeAudit(tx, { actorType: 'staff', actorId: s.staffId, actorRoles: s.roles, action: `incident.${body.status}`, targetType: 'incident', targetId: id, reason: body.outcome, ip: req.ip });
      return { status: body.status };
    });
  });

  app.get('/admin/chat-reports', { config: { auth: { staff: ['ops_safety', 'ops_support', 'ops_disputes'] } } }, async () => {
    const r = await db.query(
      `SELECT m.id, m.sender_type, m.body, m.flags, m.status, m.report_reason, m.reported_at, c.booking_id, b.legal_name, p.first_name
         FROM messages m JOIN conversations c ON c.id = m.conversation_id JOIN businesses b ON b.id = c.business_id JOIN worker_profiles p ON p.user_id = c.worker_id
        WHERE m.reported_at IS NOT NULL OR (m.status = 'blocked' AND m.sender_type = 'business') ORDER BY COALESCE(m.reported_at, m.created_at) DESC LIMIT 200`);
    return r.rows.map((m) => ({ id: m.id, from: m.sender_type, body: m.body, flags: m.flags, status: m.status, reportReason: m.report_reason, reportedAt: m.reported_at, bookingId: m.booking_id, business: m.legal_name, worker: m.first_name }));
  });

  // Reviewer stats (INT-04): how many each verifier approved, and how many of those later got a serious flag.
  app.get('/admin/reviewers', { config: { auth: { staff: ['compliance', 'super_admin'] } } }, async () => {
    const r = await db.query(
      `SELECT su.email, count(DISTINCT rv.business_id)::int AS approved,
              count(DISTINCT f.subject_id) FILTER (WHERE f.score >= 70)::int AS later_flagged
         FROM business_reviews rv JOIN staff_users su ON su.id = rv.staff_id
         LEFT JOIN fraud_flags f ON f.subject_type = 'business' AND f.subject_id = rv.business_id::text AND f.created_at > rv.created_at AND f.rule_code <> 'random_rereview'
        WHERE rv.decision = 'approve' GROUP BY su.email ORDER BY later_flagged DESC, approved DESC`);
    return r.rows;
  });

}
