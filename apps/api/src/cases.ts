// Disputes (full workflow) and safety: SOS with a trusted-contact share link, incident reports.
import { randomBytes } from 'node:crypto';
import { decrypt, encrypt, redactPII, sha256 } from '@shiftkart/shared';
import type { Db, Queryable, Tx } from './db';
import { withTx } from './db';
import { writeAudit } from './audit';
import { raiseFlag } from './fraud';
import { getPolicies } from './policy';
import { badRequest, conflict, notFound } from './lib/errors';
import { mismatchCheck } from './fraud-rules';
import { notify } from './notify/notify';
import type { Party } from './community';
import type { SmsSender } from './adapters/sms';

// ------------------------------------------------------------------ disputes

/** Opens a case with a clear timeline: acknowledged within 24 h, decided within 5 days (configurable). */
export async function openCase(tx: Tx, c: { kind: string; bookingId: string; timesheetId?: string; openedBy: 'worker' | 'business' | 'ops'; actorId: string | null; summary: string }) {
  const b = (await tx.query(`SELECT b.worker_id, s.business_id FROM bookings b JOIN shifts s ON s.id = b.shift_id WHERE b.id = $1`, [c.bookingId])).rows[0];
  const pol = await getPolicies(tx, ['dispute.ack_hours', 'dispute.decide_days']);
  const row = (await tx.query(
    `INSERT INTO dispute_cases (kind, booking_id, timesheet_id, business_id, worker_id, opened_by, summary, ack_due_at, decide_due_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now() + make_interval(hours => $8), now() + make_interval(days => $9))
     ON CONFLICT (timesheet_id) DO NOTHING RETURNING id`,
    [c.kind, c.bookingId, c.timesheetId ?? null, b.business_id, b.worker_id, c.openedBy, redactPII(c.summary), pol['dispute.ack_hours'], pol['dispute.decide_days']],
  )).rows[0];
  if (row) await tx.query(`INSERT INTO dispute_events (case_id, actor_type, actor_id, type, body) VALUES ($1, $2, $3, 'opened', $4)`, [row.id, c.openedBy, c.actorId, redactPII(c.summary)]);
  return row?.id as string | undefined;
}

export async function caseEvent(tx: Queryable, caseId: string, actorType: string, actorId: string | null, type: string, body: string, internal = false) {
  await tx.query(`INSERT INTO dispute_events (case_id, actor_type, actor_id, type, body, internal) VALUES ($1, $2, $3, $4, $5, $6)`, [caseId, actorType, actorId, type, body, internal]);
}

async function caseForParty(db: Queryable, p: Party, caseId: string) {
  const c = (await db.query('SELECT * FROM dispute_cases WHERE id = $1', [caseId])).rows[0];
  if (!c) throw notFound();
  if (p.kind === 'worker' && c.worker_id !== p.userId) throw notFound();
  if (p.kind === 'business' && c.business_id !== p.businessId) throw notFound();
  return c;
}

export async function viewCase(db: Queryable, p: Party, caseId: string) {
  const c = await caseForParty(db, p, caseId);
  const ev = await db.query(`SELECT actor_type, type, body, created_at FROM dispute_events WHERE case_id = $1 AND NOT internal ORDER BY created_at`, [caseId]);
  return {
    id: c.id, kind: c.kind, status: c.status, summary: c.summary, openedBy: c.opened_by, createdAt: c.created_at,
    ackDueAt: c.ack_due_at, decideDueAt: c.decide_due_at, decision: c.decision, decisionReason: c.decision_reason, decidedAt: c.decided_at,
    timeline: ev.rows.map((e) => ({ by: e.actor_type, type: e.type, body: e.body, at: e.created_at })),
  };
}

export async function listCases(db: Queryable, p: Party) {
  const r = await db.query(
    `SELECT c.id, c.kind, c.status, c.summary, c.created_at, c.decide_due_at, s.title FROM dispute_cases c
       LEFT JOIN bookings b ON b.id = c.booking_id LEFT JOIN shifts s ON s.id = b.shift_id
      WHERE ${p.kind === 'worker' ? 'c.worker_id = $1' : 'c.business_id = $1'} ORDER BY c.created_at DESC LIMIT 100`,
    [p.kind === 'worker' ? p.userId : p.businessId],
  );
  return r.rows.map((c) => ({ id: c.id, kind: c.kind, status: c.status, summary: c.summary, shiftTitle: c.title, createdAt: c.created_at, decideDueAt: c.decide_due_at }));
}

export async function partyOpensCase(db: Db, p: Party, input: { bookingId: string; kind: string; summary: string }) {
  return withTx(db, async (tx) => {
    const b = (await tx.query(`SELECT b.*, s.business_id FROM bookings b JOIN shifts s ON s.id = b.shift_id WHERE b.id = $1`, [input.bookingId])).rows[0];
    if (!b || (p.kind === 'worker' ? b.worker_id !== p.userId : b.business_id !== p.businessId)) throw notFound();
    const id = await openCase(tx, { kind: input.kind, bookingId: input.bookingId, openedBy: p.kind, actorId: p.userId, summary: input.summary });
    return { id };
  });
}

export async function addStatement(db: Db, p: Party, caseId: string, body: string) {
  return withTx(db, async (tx) => {
    const c = await caseForParty(tx, p, caseId);
    if (!['open', 'under_review'].includes(c.status)) throw conflict('closed', 'This case is closed.');
    await caseEvent(tx, caseId, p.kind, p.userId, 'statement', redactPII(body).slice(0, 2000));
    return { ok: true };
  });
}

/** Ops: acknowledge, add internal notes, and decide with a reason shown to both sides. */
export async function opsCaseAction(db: Db, staff: { staffId: string; roles: string[] }, caseId: string, action: { type: 'acknowledge' } | { type: 'note'; body: string } | { type: 'message'; body: string } | { type: 'decide'; decision: string; reason: string }, ip: string) {
  return withTx(db, async (tx) => {
    const c = (await tx.query('SELECT * FROM dispute_cases WHERE id = $1 FOR UPDATE', [caseId])).rows[0];
    if (!c) throw notFound();
    if (c.status === 'decided') throw conflict('closed', 'Already decided.');
    if (action.type === 'acknowledge') {
      await tx.query(`UPDATE dispute_cases SET status = 'under_review', assignee = $2, acknowledged_at = COALESCE(acknowledged_at, now()) WHERE id = $1`, [caseId, staff.staffId]);
      await caseEvent(tx, caseId, 'ops', staff.staffId, 'acknowledged', 'Our team is looking into this.');
    } else if (action.type === 'note') {
      await caseEvent(tx, caseId, 'ops', staff.staffId, 'note', action.body, true);
    } else if (action.type === 'message') {
      await caseEvent(tx, caseId, 'ops', staff.staffId, 'statement', action.body);
    } else {
      if (c.kind === 'timesheet') throw badRequest('use_timesheet_resolution', 'Timesheet disputes are decided with the minutes award, so the money moves with the decision.');
      await tx.query(`UPDATE dispute_cases SET status = 'decided', decision = $2, decision_reason = $3, decided_by = $4, decided_at = now() WHERE id = $1`, [caseId, action.decision, action.reason, staff.staffId]);
      await caseEvent(tx, caseId, 'ops', staff.staffId, 'decision', `${action.decision}. ${action.reason}`);
    }
    await writeAudit(tx, { actorType: 'staff', actorId: staff.staffId, actorRoles: staff.roles, action: `dispute.${action.type}`, targetType: 'dispute', targetId: caseId, reason: 'reason' in action ? action.reason : null, ip });
    return { ok: true };
  });
}

/** SLA watch: cases not acknowledged in time are flagged once. */
export async function disputeSlaCheck(db: Db) {
  const late = await db.query(`SELECT id FROM dispute_cases WHERE status = 'open' AND acknowledged_at IS NULL AND ack_due_at < now()`);
  for (const r of late.rows) await raiseFlag(db, 'system', `dispute:${r.id}`, 'dispute_sla_breach', { caseId: r.id }, 60);
  return late.rowCount ?? 0;
}

// ------------------------------------------------------------------ safety

export async function setTrustedContact(db: Db, workerId: string, name: string, phone: string, dataKey: string) {
  await db.query('UPDATE worker_profiles SET trusted_contact_name = $2, trusted_contact_phone_enc = $3 WHERE user_id = $1', [workerId, name, encrypt(phone, dataKey)]);
  return { ok: true };
}

/**
 * SOS during a shift: a top-priority alert to the safety team, with live location. Optionally a
 * link for the worker's trusted contact that shows their location for 4 hours, then stops working.
 */
export async function raiseSos(db: Db, workerId: string, input: { bookingId?: string; lat: number; lng: number; accuracyM: number; shareWithContact: boolean }, n: { sms: SmsSender; dataKey: string; publicBaseUrl: string }) {
  return withTx(db, async (tx) => {
    if (input.bookingId) {
      const b = await tx.query('SELECT 1 FROM bookings WHERE id = $1 AND worker_id = $2', [input.bookingId, workerId]);
      if (!b.rowCount) throw notFound();
    }
    const pol = await getPolicies(tx, ['sos.share_hours']);
    const w = (await tx.query('SELECT first_name, trusted_contact_name, trusted_contact_phone_enc FROM worker_profiles WHERE user_id = $1', [workerId])).rows[0];
    let token: string | null = null;
    if (input.shareWithContact && w?.trusted_contact_phone_enc) token = randomBytes(24).toString('base64url');
    const s = (await tx.query(
      `INSERT INTO sos_events (worker_id, booking_id, share_token_hash, share_expires_at) VALUES ($1, $2, $3, CASE WHEN $3::text IS NULL THEN NULL ELSE now() + make_interval(hours => $4) END) RETURNING id`,
      [workerId, input.bookingId ?? null, token ? sha256(token) : null, pol['sos.share_hours']],
    )).rows[0];
    await tx.query('INSERT INTO sos_locations (sos_id, lat, lng, accuracy_m) VALUES ($1, $2, $3, $4)', [s.id, input.lat, input.lng, input.accuracyM]);
    await raiseFlag(tx, 'system', `sos:${s.id}`, 'sos_open', { workerId, bookingId: input.bookingId ?? null }, 100);
    await writeAudit(tx, { actorType: 'user', actorId: workerId, action: 'safety.sos', targetType: 'sos', targetId: s.id });
    if (token) {
      const lang = (await tx.query('SELECT preferred_lang FROM users WHERE id = $1', [workerId])).rows[0].preferred_lang;
      await notify(tx, { dataKey: n.dataKey }, { toPhone: decrypt(w.trusted_contact_phone_enc, n.dataKey), lang, template: 'sos_trusted_contact',
        vars: { name: w.first_name ?? 'Your contact', hours: pol['sos.share_hours'], link: `${n.publicBaseUrl}/safety/share/${token}` }, dedupeKey: `sos:${s.id}` });
    }
    return { id: s.id as string, sharedWithContact: Boolean(token), message: 'Help is on the way. Our safety team has been alerted. If you are in danger, call 112.' };
  });
}

export async function sosLocation(db: Db, workerId: string, sosId: string, p: { lat: number; lng: number; accuracyM: number }) {
  const s = (await db.query(`SELECT 1 FROM sos_events WHERE id = $1 AND worker_id = $2 AND status <> 'resolved'`, [sosId, workerId])).rowCount;
  if (!s) throw notFound();
  await db.query('INSERT INTO sos_locations (sos_id, lat, lng, accuracy_m) VALUES ($1, $2, $3, $4)', [sosId, p.lat, p.lng, p.accuracyM]);
  return { ok: true };
}

/** The trusted contact's view: last known location, only while the link is valid. */
export async function sharedLocation(db: Queryable, token: string) {
  const s = (await db.query(
    `SELECT e.id, e.status, e.share_expires_at, p.first_name FROM sos_events e JOIN worker_profiles p ON p.user_id = e.worker_id
      WHERE e.share_token_hash = $1 AND e.share_expires_at > now()`,
    [sha256(token)],
  )).rows[0];
  if (!s) return null;
  const loc = (await db.query('SELECT lat, lng, accuracy_m, at FROM sos_locations WHERE sos_id = $1 ORDER BY at DESC LIMIT 1', [s.id])).rows[0];
  return { firstName: s.first_name, status: s.status, expiresAt: s.share_expires_at, location: loc };
}

const SEVERITY: Record<string, 'low' | 'high' | 'critical'> = {
  harassment: 'high', unsafe_site: 'high', injury: 'high', payment_demand: 'high', discrimination: 'high', underage_worker: 'high', work_mismatch: 'low', other: 'low',
};

/**
 * Incident and harassment reports. Can be anonymous: then no reporter is stored at all. They go
 * to a human, and are never shown to the business.
 */
export async function reportIncident(db: Db, p: Party, input: { category: string; description: string; bookingId?: string; anonymous: boolean }) {
  return withTx(db, async (tx) => {
    let businessId: string | null = null, siteId: string | null = null, workerOnBooking: string | null = null;
    if (input.bookingId) {
      const b = (await tx.query(`SELECT b.worker_id, s.business_id, s.site_id FROM bookings b JOIN shifts s ON s.id = b.shift_id WHERE b.id = $1`, [input.bookingId])).rows[0];
      if (!b || (p.kind === 'worker' ? b.worker_id !== p.userId : b.business_id !== p.businessId)) throw notFound();
      businessId = b.business_id; siteId = b.site_id; workerOnBooking = b.worker_id;
    } else if (p.kind === 'business') businessId = p.businessId;
    if (input.category === 'underage_worker' && (p.kind !== 'business' || !workerOnBooking)) throw badRequest('booking_required', 'Pick the booking of the worker you are reporting.');
    let severity = SEVERITY[input.category] ?? 'low';
    if (input.category === 'harassment' && input.bookingId) {
      const live = await tx.query(`SELECT 1 FROM bookings WHERE id = $1 AND status = 'checked_in'`, [input.bookingId]);
      if (live.rowCount) severity = 'critical';
    }
    const i = (await tx.query(
      `INSERT INTO incidents (reporter_type, reporter_id, category, business_id, site_id, booking_id, description, severity)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [input.anonymous ? 'anonymous' : p.kind, input.anonymous ? null : p.userId, input.category, businessId, siteId,
       input.anonymous ? null : (input.bookingId ?? null), redactPII(input.description).slice(0, 4000), severity],
    )).rows[0];
    if (severity !== 'low') await raiseFlag(tx, 'system', `incident:${i.id}`, `incident_${severity}`, { category: input.category }, severity === 'critical' ? 100 : 75);
    // WRK-06: a supervisor saying "this worker looks under 18" holds the account for review.
    if (input.category === 'underage_worker' && workerOnBooking) await raiseFlag(tx, 'worker', workerOnBooking, 'underage_report', { incidentId: i.id }, 90);
    if (input.category === 'work_mismatch' && businessId) await mismatchCheck(tx, businessId);
    return { id: i.id as string, anonymous: input.anonymous, message: 'Thank you. A person from our safety team will look at this.' };
  });
}

