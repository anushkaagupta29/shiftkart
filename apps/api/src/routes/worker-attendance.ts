import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app';
import { parse } from '../lib/validate';
import { notFound } from '../lib/errors';
import { userActor } from '../auth/guard';
import { breakEvent, clockEvent, locationPing, respondToManual } from '../attendance';
import { respondOvertime } from '../overtime';
import { getPolicies } from '../policy';

const workerAuth = { auth: { user: { kinds: ['worker' as const] } } };
const IdParam = z.object({ id: z.string().uuid() }).strict();
const Selfie = z.object({ mockPersonId: z.string().min(1).max(100), mockSpoof: z.boolean().default(false) }).strict();
const Clock = z.object({
  code: z.string().trim().min(6).max(120),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracyM: z.number().int().min(0).max(100_000),
  mockLocation: z.boolean().default(false),
  integrityToken: z.string().max(4000).optional(),
  selfie: Selfie,
  offlineOccurredAt: z.string().datetime({ offset: true }).optional(),
}).strict();
const Ping = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180), accuracyM: z.number().int().min(0).max(100_000) }).strict();

export async function workerAttendanceRoutes(app: FastifyInstance, { db, config, liveness, integrity }: AppDeps) {
  const deps = async () => ({ db, dataKey: config.dataKey, liveness, integrity, faceMatchMin: (await getPolicies(db, ['kyc.face_match_min']))['kyc.face_match_min'] });
  // Brute-forcing 6-digit gate codes is pointless (geofence + selfie), but limit tries anyway.
  const clockLimit = { max: 10, timeWindow: '1 minute', keyGenerator: (req: { headers: Record<string, unknown>; ip: string }) => String(req.headers.authorization ?? req.ip) };

  for (const type of ['check_in', 'check_out'] as const) {
    app.post(`/worker/bookings/:id/${type.replace('_', '-')}`, { config: { ...workerAuth, rateLimit: clockLimit } }, async (req) => {
      const a = userActor(req);
      const { id } = parse(IdParam, req.params);
      return clockEvent(await deps(), a.userId, id, type, parse(Clock, req.body), req.ip);
    });
  }

  app.post('/worker/bookings/:id/break', { config: workerAuth }, async (req) => {
    const a = userActor(req);
    const { id } = parse(IdParam, req.params);
    const { action } = parse(z.object({ action: z.enum(['start', 'end']) }).strict(), req.body);
    return breakEvent(db, id, a.userId, action);
  });

  app.post('/worker/bookings/:id/ping', { config: workerAuth }, async (req) => {
    const a = userActor(req);
    const { id } = parse(IdParam, req.params);
    return locationPing(db, a.userId, id, parse(Ping, req.body));
  });

  /** What the app needs to draw the "on shift" screen. */
  app.get('/worker/bookings/:id/attendance', { config: workerAuth }, async (req) => {
    const a = userActor(req);
    const { id } = parse(IdParam, req.params);
    const b = (await db.query(`SELECT id, status, shift_id, confirmed_attendance FROM bookings WHERE id = $1 AND worker_id = $2`, [id, a.userId])).rows[0];
    if (!b) throw notFound();
    const ev = await db.query(
      `SELECT id, type, mode, status, effective_at, flags FROM attendance_events WHERE booking_id = $1 AND status <> 'rejected' ORDER BY effective_at`, [id]);
    const lastBreak = [...ev.rows].reverse().find((e) => e.type === 'break_start' || e.type === 'break_end');
    const ot = await db.query(`SELECT id, extra_minutes, worker_pay_paise, status FROM overtime_requests WHERE booking_id = $1 ORDER BY created_at DESC`, [id]);
    const ts = (await db.query(`SELECT id, status, payable_minutes, overtime_minutes, gross_paise, disputed_paise, approval_deadline FROM timesheets WHERE booking_id = $1`, [id])).rows[0];
    return {
      bookingStatus: b.status, confirmedAttendance: b.confirmed_attendance, onBreak: lastBreak?.type === 'break_start',
      events: ev.rows.map((e) => ({ id: e.id, type: e.type, mode: e.mode, status: e.status, at: e.effective_at, flags: e.flags })),
      overtime: ot.rows.map((o) => ({ id: o.id, extraMinutes: o.extra_minutes, workerPayPaise: Number(o.worker_pay_paise), status: o.status })),
      timesheet: ts ? { id: ts.id, status: ts.status, minutes: ts.payable_minutes + ts.overtime_minutes, grossPaise: Number(ts.gross_paise), heldPaise: Number(ts.disputed_paise ?? 0), approvalDeadline: ts.approval_deadline } : null,
    };
  });

  app.get('/worker/attendance/pending', { config: workerAuth }, async (req) => {
    const a = userActor(req);
    const r = await db.query(
      `SELECT e.id, e.type, e.effective_at, e.reason, s.title FROM attendance_events e JOIN shifts s ON s.id = e.shift_id
        WHERE e.worker_id = $1 AND e.status = 'pending_confirmation'
          AND NOT EXISTS (SELECT 1 FROM attendance_events c WHERE c.confirms_event_id = e.id)
        ORDER BY e.effective_at`,
      [a.userId],
    );
    return r.rows.map((e) => ({ id: e.id, type: e.type, at: e.effective_at, reason: e.reason, shiftTitle: e.title }));
  });

  app.post('/worker/attendance/:id/confirm', { config: workerAuth }, async (req) => {
    const a = userActor(req);
    const { id } = parse(IdParam, req.params);
    const { selfie } = parse(z.object({ selfie: Selfie }).strict(), req.body);
    return respondToManual(await deps(), a.userId, id, true, selfie, req.ip);
  });

  app.post('/worker/attendance/:id/reject', { config: workerAuth }, async (req) => {
    const a = userActor(req);
    const { id } = parse(IdParam, req.params);
    return respondToManual(await deps(), a.userId, id, false, { mockPersonId: 'none' }, req.ip);
  });

  for (const action of ['accept', 'decline'] as const) {
    app.post(`/worker/overtime/:id/${action}`, { config: workerAuth }, async (req) => {
      const a = userActor(req);
      const { id } = parse(IdParam, req.params);
      return respondOvertime(db, a.userId, id, action === 'accept', req.ip);
    });
  }

  app.get('/worker/payslips', { config: workerAuth }, async (req) => {
    const a = userActor(req);
    const r = await db.query(
      `SELECT p.id, p.number, p.net_paise, p.created_at, p.lines->'shift' AS shift FROM payslips p WHERE p.worker_id = $1 ORDER BY p.created_at DESC LIMIT 100`,
      [a.userId],
    );
    const pending = await db.query(
      `SELECT COALESCE(sum(amount_paise), 0)::bigint AS s, count(*)::int AS n FROM payouts WHERE worker_id = $1 AND status IN ('queued', 'processing', 'held')`, [a.userId]);
    const held = await db.query(`SELECT held_reason FROM payouts WHERE worker_id = $1 AND status = 'held' LIMIT 1`, [a.userId]);
    return {
      items: r.rows.map((p) => ({ id: p.id, number: p.number, netPaise: Number(p.net_paise), paidAt: p.created_at, shift: p.shift })),
      onTheWay: { paise: pending.rows[0].s, count: pending.rows[0].n, heldReason: held.rows[0]?.held_reason ?? null },
    };
  });

  app.get('/worker/payslips/:id', { config: workerAuth }, async (req) => {
    const a = userActor(req);
    const { id } = parse(IdParam, req.params);
    const p = (await db.query('SELECT * FROM payslips WHERE id = $1 AND worker_id = $2', [id, a.userId])).rows[0];
    if (!p) throw notFound();
    return { id: p.id, number: p.number, issuedAt: p.created_at, ...p.lines, grossPaise: Number(p.gross_paise), deductionsPaise: Number(p.deductions_paise), netPaise: Number(p.net_paise) };
  });
}
