import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app';
import type { Queryable } from '../db';
import { audit } from '../audit';
import { parse } from '../lib/validate';
import { conflict, forbidden, notFound } from '../lib/errors';
import { userActor } from '../auth/guard';
import { requireMember } from './businesses';
import { breakEvent, manualAttendance, siteSecret } from '../attendance';
import { approveTimesheet, disputeTimesheet } from '../money';
import { requestOvertime } from '../overtime';
import { getPolicies } from '../policy';
import { QR_PERIOD_SEC, shiftKey } from '../domain/qr';

const bizAuth = { auth: { user: { kinds: ['business' as const] } } };
const ShiftParams = z.object({ businessId: z.string().uuid(), shiftId: z.string().uuid() }).strict();
const BookingParams = z.object({ businessId: z.string().uuid(), bookingId: z.string().uuid() }).strict();
const TsParams = z.object({ businessId: z.string().uuid(), timesheetId: z.string().uuid() }).strict();
const BizParams = z.object({ businessId: z.string().uuid() }).strict();

/** Supervisors may be limited to some sites (empty list = all sites). */
async function memberForSite(db: Queryable, businessId: string, userId: string, siteId: string) {
  const m = await requireMember(db, businessId, userId);
  const sites = (await db.query('SELECT site_ids FROM business_members WHERE id = $1', [m.id])).rows[0].site_ids as string[];
  if (sites.length && !sites.includes(siteId)) throw forbidden('You are not assigned to this site.');
  return m;
}

async function bookingForBusiness(db: Queryable, businessId: string, bookingId: string) {
  const b = (await db.query(`SELECT b.*, s.site_id, s.business_id FROM bookings b JOIN shifts s ON s.id = b.shift_id WHERE b.id = $1`, [bookingId])).rows[0];
  if (!b || b.business_id !== businessId) throw notFound();
  return b;
}

export async function businessAttendanceRoutes(app: FastifyInstance, { db, config }: AppDeps) {
  /**
   * The gate screen. Gives the supervisor's phone a key for this one shift so it can show rotating
   * codes even with no network. Only during the shift's window; every issue is audited.
   */
  app.get('/businesses/:businessId/shifts/:shiftId/gate', { config: bizAuth }, async (req) => {
    const a = userActor(req);
    const { businessId, shiftId } = parse(ShiftParams, req.params);
    const s = (await db.query(`SELECT s.*, si.name AS site_name FROM shifts s JOIN sites si ON si.id = s.site_id WHERE s.id = $1 AND s.business_id = $2`, [shiftId, businessId])).rows[0];
    if (!s) throw notFound();
    await memberForSite(db, businessId, a.userId, s.site_id);
    if (s.status !== 'live') throw conflict('not_live', 'This shift is not live.');
    const pol = await getPolicies(db, ['attendance.checkin_opens_min_before', 'attendance.checkout_grace_min_after']);
    const opens = new Date(s.starts_at.getTime() - pol['attendance.checkin_opens_min_before'] * 60_000);
    const closes = new Date(s.ends_at.getTime() + (pol['attendance.checkout_grace_min_after'] + 240) * 60_000);
    if (Date.now() < opens.getTime() || Date.now() > closes.getTime()) {
      throw conflict('gate_closed', `The gate code opens ${pol['attendance.checkin_opens_min_before']} minutes before the shift starts.`);
    }
    const key = shiftKey(await siteSecret(db, s.site_id, config.dataKey), shiftId);
    await audit(db, { actorType: 'user', actorId: a.userId, action: 'gate.key_issued', targetType: 'shift', targetId: shiftId, ip: req.ip });
    return { shiftId, siteName: s.site_name, title: s.title, keyB64: key.toString('base64'), periodSec: QR_PERIOD_SEC, serverTime: new Date().toISOString(), opensAt: opens, closesAt: closes };
  });

  app.get('/businesses/:businessId/shifts/:shiftId/attendance', { config: bizAuth }, async (req) => {
    const a = userActor(req);
    const { businessId, shiftId } = parse(ShiftParams, req.params);
    const s = (await db.query('SELECT site_id FROM shifts WHERE id = $1 AND business_id = $2', [shiftId, businessId])).rows[0];
    if (!s) throw notFound();
    await memberForSite(db, businessId, a.userId, s.site_id);
    const r = await db.query(
      `SELECT b.id, b.status, p.first_name,
              (SELECT json_agg(json_build_object('type', e.type, 'at', e.effective_at, 'mode', e.mode, 'status', e.status, 'flags', e.flags) ORDER BY e.effective_at)
                 FROM attendance_events e WHERE e.booking_id = b.id AND e.status <> 'rejected') AS events,
              (SELECT count(*)::int FROM attendance_events e WHERE e.booking_id = b.id AND e.status = 'rejected') AS failed_attempts,
              (SELECT json_build_object('id', o.id, 'status', o.status, 'extraMinutes', o.extra_minutes) FROM overtime_requests o WHERE o.booking_id = b.id ORDER BY o.created_at DESC LIMIT 1) AS overtime
         FROM bookings b JOIN worker_profiles p ON p.user_id = b.worker_id
        WHERE b.shift_id = $1 AND b.status IN ('confirmed', 'checked_in', 'completed', 'no_show') ORDER BY p.first_name`,
      [shiftId],
    );
    return r.rows.map((b) => {
      const ev = (b.events ?? []) as { type: string; at: string; flags: string[]; status: string; mode: string }[];
      const last = [...ev].reverse().find((e) => e.type.startsWith('break'));
      return {
        bookingId: b.id, firstName: b.first_name, status: b.status, onBreak: last?.type === 'break_start',
        checkedInAt: ev.find((e) => e.type === 'check_in')?.at ?? null, checkedOutAt: ev.find((e) => e.type === 'check_out')?.at ?? null,
        // Supervisor sees flags so they can look at the person (WRK-04), never raw scores or locations.
        flags: [...new Set(ev.flatMap((e) => e.flags))], manual: ev.some((e) => e.mode === 'offline_supervisor'),
        failedAttempts: b.failed_attempts, overtime: b.overtime,
      };
    });
  });

  app.post('/businesses/:businessId/bookings/:bookingId/manual', { config: bizAuth }, async (req) => {
    const a = userActor(req);
    const { businessId, bookingId } = parse(BookingParams, req.params);
    const body = parse(z.object({ type: z.enum(['check_in', 'check_out']), at: z.string().datetime({ offset: true }), reason: z.string().trim().min(10).max(300) }).strict(), req.body);
    const b = await bookingForBusiness(db, businessId, bookingId);
    const m = await memberForSite(db, businessId, a.userId, b.site_id);
    return manualAttendance(db, { businessId, memberId: m.id, userId: a.userId }, bookingId, body.type, body.at, body.reason, req.ip);
  });

  app.post('/businesses/:businessId/bookings/:bookingId/break', { config: bizAuth }, async (req) => {
    const a = userActor(req);
    const { businessId, bookingId } = parse(BookingParams, req.params);
    const { action } = parse(z.object({ action: z.enum(['start', 'end']) }).strict(), req.body);
    const b = await bookingForBusiness(db, businessId, bookingId);
    const m = await memberForSite(db, businessId, a.userId, b.site_id);
    return breakEvent(db, bookingId, b.worker_id, action, { supervisorMemberId: m.id });
  });

  app.post('/businesses/:businessId/bookings/:bookingId/overtime', { config: bizAuth }, async (req, reply) => {
    const a = userActor(req);
    const { businessId, bookingId } = parse(BookingParams, req.params);
    const { extraMinutes } = parse(z.object({ extraMinutes: z.number().int().min(15).max(240) }).strict(), req.body);
    await requireMember(db, businessId, a.userId, ['owner', 'manager']);
    reply.code(201);
    return requestOvertime(db, { businessId, userId: a.userId }, bookingId, extraMinutes, req.ip);
  });

  app.get('/businesses/:businessId/timesheets', { config: bizAuth }, async (req) => {
    const a = userActor(req);
    const { businessId } = parse(BizParams, req.params);
    await requireMember(db, businessId, a.userId);
    const r = await db.query(
      `SELECT t.*, p.first_name, s.title, s.starts_at AS s_start, s.ends_at AS s_end FROM timesheets t
         JOIN worker_profiles p ON p.user_id = t.worker_id JOIN shifts s ON s.id = t.shift_id
        WHERE t.business_id = $1 ORDER BY (t.status = 'pending_approval') DESC, t.created_at DESC LIMIT 200`,
      [businessId],
    );
    return r.rows.map((t) => ({
      id: t.id, firstName: t.first_name, shiftTitle: t.title, shiftStart: t.s_start, shiftEnd: t.s_end, startedAt: t.started_at, endedAt: t.ended_at,
      breakMinutes: t.break_minutes, payableMinutes: t.payable_minutes, overtimeMinutes: t.overtime_minutes, grossPaise: Number(t.gross_paise),
      basePayPaise: Number(t.base_pay_paise), overtimePayPaise: Number(t.overtime_pay_paise), allowancesPaise: Number(t.allowances_paise),
      flags: t.flags, status: t.status, approvalDeadline: t.approval_deadline, disputedMinutes: t.disputed_minutes, disputedPaise: t.disputed_paise ? Number(t.disputed_paise) : null,
    }));
  });

  app.post('/businesses/:businessId/timesheets/:timesheetId/approve', { config: bizAuth }, async (req) => {
    const a = userActor(req);
    const { businessId, timesheetId } = parse(TsParams, req.params);
    await requireMember(db, businessId, a.userId, ['owner', 'manager']);
    return approveTimesheet(db, { id: timesheetId, businessId }, { userId: a.userId }, req.ip);
  });

  app.post('/businesses/:businessId/timesheets/:timesheetId/dispute', { config: bizAuth }, async (req) => {
    const a = userActor(req);
    const { businessId, timesheetId } = parse(TsParams, req.params);
    const body = parse(z.object({
      minutes: z.number().int().min(1).max(1000),
      category: z.enum(['arrived_late', 'left_early', 'long_breaks', 'not_working', 'did_not_attend', 'other']),
      reason: z.string().trim().min(1).max(1000),
    }).strict(), req.body);
    await requireMember(db, businessId, a.userId, ['owner', 'manager']);
    return disputeTimesheet(db, { id: timesheetId, businessId }, a.userId, body, req.ip);
  });

  app.get('/businesses/:businessId/invoices', { config: bizAuth }, async (req) => {
    const a = userActor(req);
    const { businessId } = parse(BizParams, req.params);
    await requireMember(db, businessId, a.userId, ['owner', 'manager']);
    const r = await db.query(`SELECT * FROM invoices WHERE business_id = $1 ORDER BY issued_at DESC LIMIT 200`, [businessId]);
    return r.rows.map((i) => ({
      id: i.id, number: i.number, shiftId: i.shift_id, issuedAt: i.issued_at, buyer: i.buyer, seller: i.seller, lines: i.lines,
      taxablePaise: Number(i.taxable_paise), cgstPaise: Number(i.cgst_paise), sgstPaise: Number(i.sgst_paise), igstPaise: Number(i.igst_paise), totalPaise: Number(i.total_paise),
    }));
  });

  app.get('/businesses/:businessId/shifts/:shiftId/money', { config: bizAuth }, async (req) => {
    const a = userActor(req);
    const { businessId, shiftId } = parse(ShiftParams, req.params);
    await requireMember(db, businessId, a.userId, ['owner', 'manager']);
    const s = (await db.query('SELECT total_paise, settled_at FROM shifts WHERE id = $1 AND business_id = $2', [shiftId, businessId])).rows[0];
    if (!s) throw notFound();
    const r = await db.query(
      `SELECT j.kind, -sum(e.amount_paise)::bigint AS amount FROM journals j JOIN ledger_entries e ON e.journal_id = j.id JOIN ledger_accounts a ON a.id = e.account_id
        WHERE a.code = $1 GROUP BY j.kind`,
      [`shift_escrow:${shiftId}`],
    );
    const by = Object.fromEntries(r.rows.map((x) => [x.kind, Number(x.amount)]));
    const refunds = await db.query(`SELECT amount_paise, created_at FROM refunds WHERE shift_id = $1`, [shiftId]);
    return {
      fundedPaise: -(by.fund ?? 0), releasedPaise: by.fee ?? 0, refundedPaise: by.refund ?? 0, settledAt: s.settled_at,
      heldPaise: -(by.fund ?? 0) - (by.fee ?? 0) - (by.refund ?? 0) - (by.chargeback ?? 0),
      refunds: refunds.rows.map((x) => ({ amountPaise: Number(x.amount_paise), at: x.created_at })),
    };
  });
}
