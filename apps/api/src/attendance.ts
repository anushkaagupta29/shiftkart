import { randomBytes } from 'node:crypto';
import { decrypt, encrypt } from '@shiftkart/shared';
import type { Db, Queryable, Tx } from './db';
import { withTx } from './db';
import { writeAudit } from './audit';
import { raiseFlag } from './fraud';
import { getPolicies } from './policy';
import { HttpError, badRequest, conflict, forbidden, notFound } from './lib/errors';
import { QR_PERIOD_SEC, shiftKey, verifyGateCode } from './domain/qr';
import { computeTimesheet } from './domain/timesheet';
import { cosineScore, fromPgVector, type LivenessProvider } from './adapters/mock-face';
import type { IntegrityVerifier } from './adapters/payouts';
import { notifyBusiness } from './notify/notify';

export type ClockInput = {
  code: string;
  lat: number;
  lng: number;
  accuracyM: number;
  mockLocation: boolean;
  integrityToken?: string;
  selfie: { mockPersonId: string; mockSpoof?: boolean };
  /** Set when the phone had no network: when it scanned, by the phone's clock. */
  offlineOccurredAt?: string;
};

type Deps = { db: Db; dataKey: string; liveness: LivenessProvider; integrity: IntegrityVerifier; faceMatchMin: number };

const POLICY_KEYS = [
  'attendance.checkin_opens_min_before', 'attendance.checkout_grace_min_after', 'attendance.gps_accuracy_flag_m',
  'attendance.gps_tolerance_max_m', 'attendance.offline_max_age_hours', 'attendance.clock_drift_flag_sec',
  'attendance.late_checkout_flag_min', 'attendance.left_site_flag_min', 'timesheet.approval_window_hours',
  'overtime.multiplier_bp', 'kyc.face_match_min',
] as const;

/** The site's QR secret, created on first use. Never sent to any client. */
export async function siteSecret(db: Queryable, siteId: string, dataKey: string): Promise<string> {
  const r = await db.query('SELECT qr_secret_enc FROM sites WHERE id = $1', [siteId]);
  if (r.rows[0]?.qr_secret_enc) return decrypt(r.rows[0].qr_secret_enc, dataKey);
  const fresh = randomBytes(32).toString('base64');
  const u = await db.query('UPDATE sites SET qr_secret_enc = $2 WHERE id = $1 AND qr_secret_enc IS NULL RETURNING id', [siteId, encrypt(fresh, dataKey)]);
  if (u.rowCount) return fresh;
  return siteSecret(db, siteId, dataKey); // someone else created it first
}

async function loadContext(tx: Tx, workerId: string, bookingId: string) {
  const b = (await tx.query(
    `SELECT b.*, s.starts_at AS s_start, s.ends_at AS s_end, s.site_id, s.business_id, s.status AS shift_status, s.break_minutes,
            si.geofence_m, si.status AS site_status
       FROM bookings b JOIN shifts s ON s.id = b.shift_id JOIN sites si ON si.id = s.site_id
      WHERE b.id = $1 AND b.worker_id = $2 FOR UPDATE OF b`,
    [bookingId, workerId],
  )).rows[0];
  if (!b) throw notFound('Booking not found.');
  return b;
}

/**
 * Check-in / check-out (SPEC §6.5). Three proofs: inside the site geofence, a current gate code from
 * the supervisor's phone, and a live selfie matching the worker. Device signals (mock GPS, failed
 * integrity, poor accuracy) are recorded as flags for review, not silent blocks (WRK-04).
 * Failed attempts are recorded too, so repeated tries are visible to the fraud team.
 */
export async function clockEvent(d: Deps, workerId: string, bookingId: string, type: 'check_in' | 'check_out', input: ClockInput, ip: string) {
  const now = Date.now();
  const verdict = await d.integrity.verify(input.integrityToken);
  const selfie = await d.liveness.check(input.selfie);

  const outcome = await withTx(d.db, async (tx) => {
    const pol = await getPolicies(tx, POLICY_KEYS);
    const b = await loadContext(tx, workerId, bookingId);
    if (type === 'check_in' && b.status !== 'confirmed') throw conflict('bad_state', b.status === 'checked_in' ? 'You are already checked in.' : 'This booking cannot be checked in.');
    if (type === 'check_out' && b.status !== 'checked_in') throw conflict('bad_state', 'Check in first.');
    if (b.site_status !== 'active') throw conflict('site_paused', 'This site is paused. Contact support.');

    // When did this happen? Online: now. Offline: the phone's time, but we trust the QR step more (SYS-08).
    const offline = Boolean(input.offlineOccurredAt);
    let atMs = now;
    if (offline) {
      atMs = Date.parse(input.offlineOccurredAt!);
      if (!Number.isFinite(atMs) || atMs > now + 60_000) throw badRequest('bad_time', 'Invalid time.');
      if (now - atMs > pol['attendance.offline_max_age_hours'] * 3600_000) throw badRequest('too_old', 'This offline record is too old to accept. Ask your supervisor.');
    }

    const otMin = (await tx.query(`SELECT COALESCE(sum(extra_minutes), 0)::int AS m FROM overtime_requests WHERE booking_id = $1 AND status = 'accepted'`, [bookingId])).rows[0].m;
    const opens = b.s_start.getTime() - pol['attendance.checkin_opens_min_before'] * 60_000;
    const closes = b.s_end.getTime() + (otMin + pol['attendance.checkout_grace_min_after']) * 60_000;
    if (type === 'check_in' && (atMs < opens || atMs > b.s_end.getTime())) {
      throw conflict('outside_window', `Check-in opens ${pol['attendance.checkin_opens_min_before']} minutes before the shift starts.`);
    }
    if (type === 'check_out' && atMs > closes) throw conflict('outside_window', 'Check-out has closed for this shift. Ask your supervisor.');

    const flags: string[] = [];
    const reject = async (reason: string, err: HttpError, extra: Record<string, unknown> = {}) => {
      await tx.query(
        `INSERT INTO attendance_events (booking_id, worker_id, shift_id, type, mode, status, occurred_at, effective_at, lat, lng, accuracy_m, mock_location, integrity_verdict, flags, reason)
         VALUES ($1, $2, $3, $4, $5, 'rejected', $6, now(), $7, $8, $9, $10, $11, $12, $13)`,
        [bookingId, workerId, b.shift_id, type, offline ? 'offline_qr' : 'online', offline ? new Date(atMs) : null, input.lat, input.lng, input.accuracyM, input.mockLocation, verdict, [reason, ...flags], JSON.stringify(extra)],
      );
      return { error: err };
    };

    // 1. Gate code, checked against the time it was scanned.
    const secret = await siteSecret(tx, b.site_id, d.dataKey);
    const qr = verifyGateCode(shiftKey(secret, b.shift_id), b.shift_id, input.code, atMs);
    if (!qr.ok) {
      return reject(`qr_${qr.reason}`, badRequest('bad_code', qr.reason === 'wrong_shift' ? 'This code is for a different shift.' : 'That code is not valid now. Scan the code on the supervisor\'s phone again.'));
    }
    const stepMs = qr.step * QR_PERIOD_SEC * 1000;
    let effectiveAt = new Date(now);
    if (offline) {
      effectiveAt = new Date(stepMs + (QR_PERIOD_SEC * 1000) / 2);
      if (Math.abs(atMs - stepMs) > pol['attendance.clock_drift_flag_sec'] * 1000) flags.push('clock_mismatch');
      flags.push('offline_sync');
    }

    // 2. Geofence, with tolerance for GPS accuracy (capped, so "accuracy: 5 km" doesn't open the gate).
    const geo = (await tx.query(
      `SELECT round(ST_Distance(location, ST_MakePoint($2, $3)::geography))::int AS dist FROM sites WHERE id = $1`,
      [b.site_id, input.lng, input.lat],
    )).rows[0];
    const tolerance = Math.min(Math.max(input.accuracyM, 0), pol['attendance.gps_tolerance_max_m']);
    if (geo.dist > b.geofence_m + tolerance) {
      return reject('outside_site', badRequest('outside_site', `You seem to be ${geo.dist} m from the site. Move inside, or ask the supervisor for help.`), { distance: geo.dist });
    }
    if (input.accuracyM > pol['attendance.gps_accuracy_flag_m']) flags.push('low_gps_accuracy');

    // 3. Device signals → flags (WRK-04).
    if (input.mockLocation) flags.push('mock_location');
    if (verdict === 'fail') flags.push('device_integrity_fail');
    if (verdict === 'missing') flags.push('integrity_missing');

    // 4. Live selfie of the account holder (WRK-02, WRK-03).
    const w = (await tx.query('SELECT face_embedding FROM worker_profiles WHERE user_id = $1', [workerId])).rows[0];
    if (!selfie.live) return reject('liveness_failed', badRequest('liveness_failed', 'We could not confirm a live selfie. Try again.'));
    const score = cosineScore(fromPgVector(w.face_embedding), selfie.embedding);
    if (score < pol['kyc.face_match_min']) {
      await raiseFlag(tx, 'worker', workerId, 'attendance_face_mismatch', { bookingId, score, type }, 85);
      return reject('face_mismatch', badRequest('face_mismatch', 'The selfie does not match your profile. Only the person who booked can work this shift.'), { score });
    }

    if (type === 'check_out' && effectiveAt.getTime() > b.s_end.getTime() + (otMin + pol['attendance.late_checkout_flag_min']) * 60_000) {
      flags.push('stayed_late_no_overtime'); // PAY-06: were they asked to stay without agreed overtime?
    }

    let ev;
    try {
      ev = (await tx.query(
        `INSERT INTO attendance_events (booking_id, worker_id, shift_id, type, mode, status, occurred_at, effective_at, lat, lng, accuracy_m,
            distance_m, qr_step, face_score, liveness_ok, mock_location, integrity_verdict, flags)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,true,$15,$16,$17) RETURNING id, status, effective_at`,
        [bookingId, workerId, b.shift_id, type, offline ? 'offline_qr' : 'online', flags.some((f) => f !== 'offline_sync') ? 'flagged' : 'accepted',
         offline ? new Date(atMs) : null, effectiveAt, input.lat, input.lng, input.accuracyM, geo.dist, qr.step, score, input.mockLocation, verdict, flags],
      )).rows[0];
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw conflict('already_done', type === 'check_in' ? 'You are already checked in.' : 'You already checked out.');
      throw e;
    }
    if (flags.includes('mock_location') || flags.includes('device_integrity_fail')) {
      await raiseFlag(tx, 'worker', workerId, 'attendance_spoof_suspected', { bookingId, flags }, 70);
    }
    await tx.query('UPDATE bookings SET status = $2 WHERE id = $1', [bookingId, type === 'check_in' ? 'checked_in' : 'completed']);
    let timesheet = null;
    if (type === 'check_out') timesheet = await createTimesheet(tx, bookingId, d.dataKey);
    await writeAudit(tx, { actorType: 'user', actorId: workerId, action: `attendance.${type}`, targetType: 'booking', targetId: bookingId, after: { flags, mode: offline ? 'offline_qr' : 'online' }, ip });
    return { eventId: ev.id as string, status: ev.status as string, at: ev.effective_at as Date, flags, timesheet };
  });
  if ('error' in outcome) throw outcome.error;
  return outcome;
}

export async function breakEvent(db: Db, bookingId: string, workerId: string, action: 'start' | 'end', by: { supervisorMemberId?: string } = {}) {
  return withTx(db, async (tx) => {
    const b = await loadContext(tx, workerId, bookingId);
    if (b.status !== 'checked_in') throw conflict('bad_state', 'Breaks can only be recorded during a shift.');
    const last = (await tx.query(
      `SELECT type FROM attendance_events WHERE booking_id = $1 AND type IN ('break_start', 'break_end') AND status <> 'rejected' ORDER BY effective_at DESC LIMIT 1`,
      [bookingId],
    )).rows[0];
    const onBreak = last?.type === 'break_start';
    if (action === 'start' && onBreak) throw conflict('on_break', 'Already on a break.');
    if (action === 'end' && !onBreak) throw conflict('not_on_break', 'No break to end.');
    await tx.query(
      `INSERT INTO attendance_events (booking_id, worker_id, shift_id, type, mode, status, effective_at, supervisor_member_id)
       VALUES ($1, $2, $3, $4, 'online', 'accepted', now(), $5)`,
      [bookingId, workerId, b.shift_id, action === 'start' ? 'break_start' : 'break_end', by.supervisorMemberId ?? null],
    );
    return { onBreak: action === 'start' };
  });
}

/** WRK-12: optional location pings during a shift (with consent). Long absences become a review flag. */
export async function locationPing(db: Db, workerId: string, bookingId: string, p: { lat: number; lng: number; accuracyM: number }) {
  return withTx(db, async (tx) => {
    const b = await loadContext(tx, workerId, bookingId);
    if (b.status !== 'checked_in') throw conflict('bad_state', 'Not on shift.');
    const consent = await tx.query(`SELECT 1 FROM consents WHERE user_id = $1 AND purpose = 'location_at_shift' AND withdrawn_at IS NULL`, [workerId]);
    if (!consent.rowCount) throw forbidden('Location sharing during shifts is off.');
    const pol = await getPolicies(tx, ['attendance.gps_tolerance_max_m', 'attendance.left_site_flag_min']);
    const geo = (await tx.query(`SELECT round(ST_Distance(location, ST_MakePoint($2, $3)::geography))::int AS dist FROM sites WHERE id = $1`, [b.site_id, p.lng, p.lat])).rows[0];
    const inside = geo.dist <= b.geofence_m + Math.min(p.accuracyM, pol['attendance.gps_tolerance_max_m']);
    await tx.query('INSERT INTO attendance_pings (booking_id, inside, distance_m, accuracy_m) VALUES ($1, $2, $3, $4)', [bookingId, inside, geo.dist, p.accuracyM]);
    if (!inside) {
      const streak = (await tx.query(
        `SELECT COALESCE(
           (SELECT min(at) FROM attendance_pings WHERE booking_id = $1 AND NOT inside
              AND at > COALESCE((SELECT max(at) FROM attendance_pings WHERE booking_id = $1 AND inside), '-infinity')),
           now()) AS since`,
        [bookingId],
      )).rows[0].since as Date;
      const onBreak = (await tx.query(
        `SELECT type FROM attendance_events WHERE booking_id = $1 AND type IN ('break_start', 'break_end') ORDER BY effective_at DESC LIMIT 1`, [bookingId],
      )).rows[0]?.type === 'break_start';
      const mins = (Date.now() - since(streak)) / 60_000;
      if (!onBreak && mins >= pol['attendance.left_site_flag_min']) {
        await raiseFlag(tx, 'worker', workerId, 'left_site_during_shift', { bookingId, minutes: Math.round(mins), distance: geo.dist }, 40);
      }
    }
    return { inside };
  });
}
const since = (d: Date) => d.getTime();

/**
 * Supervisor's offline fallback (phone dead, no network): record attendance by hand. It's marked as
 * such, needs the worker's own confirmation (with a selfie) before it can be paid (PAY-12), and a
 * supervisor who relies on it a lot gets flagged.
 */
export async function manualAttendance(db: Db, s: { businessId: string; memberId: string; userId: string }, bookingId: string, type: 'check_in' | 'check_out', atIso: string, reason: string, ip: string) {
  return withTx(db, async (tx) => {
    const b = (await tx.query(
      `SELECT b.*, s.starts_at AS s_start, s.ends_at AS s_end, s.business_id FROM bookings b JOIN shifts s ON s.id = b.shift_id WHERE b.id = $1 FOR UPDATE OF b`,
      [bookingId],
    )).rows[0];
    if (!b || b.business_id !== s.businessId) throw notFound();
    const at = new Date(atIso);
    if (!Number.isFinite(at.getTime()) || at.getTime() > Date.now() + 60_000) throw badRequest('bad_time', 'Invalid time.');
    if (at.getTime() < b.s_start.getTime() - 3600_000 || at.getTime() > b.s_end.getTime() + 4 * 3600_000) throw badRequest('bad_time', 'That time is outside this shift.');
    if (type === 'check_in' && b.status !== 'confirmed') throw conflict('bad_state', 'Already checked in.');
    if (type === 'check_out' && b.status !== 'checked_in') throw conflict('bad_state', 'Not checked in.');
    const ev = (await tx.query(
      `INSERT INTO attendance_events (booking_id, worker_id, shift_id, type, mode, status, effective_at, supervisor_member_id, reason, flags)
       VALUES ($1, $2, $3, $4, 'offline_supervisor', 'pending_confirmation', $5, $6, $7, '{manual_by_supervisor}') RETURNING id`,
      [bookingId, b.worker_id, b.shift_id, type, at, s.memberId, reason],
    )).rows[0];
    await tx.query('UPDATE bookings SET status = $2 WHERE id = $1', [bookingId, type === 'check_in' ? 'checked_in' : 'completed']);
    if (type === 'check_out') await createTimesheet(tx, bookingId);

    const ratio = (await tx.query(
      `SELECT count(*) FILTER (WHERE mode = 'offline_supervisor')::int AS manual, count(*)::int AS total FROM attendance_events
        WHERE type IN ('check_in', 'check_out') AND status <> 'rejected' AND created_at > now() - interval '30 days'
          AND shift_id IN (SELECT id FROM shifts WHERE business_id = $1)`,
      [s.businessId],
    )).rows[0];
    if (ratio.manual >= 5 && ratio.manual * 100 > ratio.total * 30) {
      await raiseFlag(tx, 'business', s.businessId, 'supervisor_manual_ratio', { manual: ratio.manual, total: ratio.total, member: s.memberId }, 50);
    }
    await writeAudit(tx, { actorType: 'user', actorId: s.userId, action: `attendance.manual_${type}`, targetType: 'booking', targetId: bookingId, reason, after: { at: at.toISOString() }, ip });
    return { eventId: ev.id as string, status: 'pending_confirmation' };
  });
}

/** The worker confirms (with a live selfie) or rejects attendance their supervisor recorded by hand. */
export async function respondToManual(d: Deps, workerId: string, eventId: string, confirm: boolean, selfie: { mockPersonId: string; mockSpoof?: boolean }, ip: string) {
  const check = confirm ? await d.liveness.check(selfie) : null;
  return withTx(d.db, async (tx) => {
    const ev = (await tx.query(`SELECT * FROM attendance_events WHERE id = $1 AND worker_id = $2 AND status = 'pending_confirmation'`, [eventId, workerId])).rows[0];
    if (!ev) throw notFound();
    const done = await tx.query(`SELECT 1 FROM attendance_events WHERE confirms_event_id = $1`, [eventId]);
    if (done.rowCount) throw conflict('already_answered', 'Already answered.');
    if (!confirm) {
      await tx.query(
        `INSERT INTO attendance_events (booking_id, worker_id, shift_id, type, mode, status, effective_at, confirms_event_id, reason)
         VALUES ($1, $2, $3, 'worker_confirm', 'online', 'rejected', now(), $4, 'worker says this is wrong')`,
        [ev.booking_id, workerId, ev.shift_id, eventId],
      );
      const biz = (await tx.query('SELECT business_id FROM shifts WHERE id = $1', [ev.shift_id])).rows[0].business_id;
      await raiseFlag(tx, 'business', biz, 'manual_attendance_disputed', { eventId, worker: workerId }, 70);
      return { confirmed: false };
    }
    const w = (await tx.query('SELECT face_embedding FROM worker_profiles WHERE user_id = $1', [workerId])).rows[0];
    const pol = await getPolicies(tx, ['kyc.face_match_min']);
    if (!check!.live || cosineScore(fromPgVector(w.face_embedding), check!.embedding) < pol['kyc.face_match_min']) {
      throw badRequest('face_mismatch', 'Selfie did not match. Try again.');
    }
    await tx.query(
      `INSERT INTO attendance_events (booking_id, worker_id, shift_id, type, mode, status, effective_at, confirms_event_id)
       VALUES ($1, $2, $3, 'worker_confirm', 'online', 'accepted', now(), $4)`,
      [ev.booking_id, workerId, ev.shift_id, eventId],
    );
    // Once nothing is left unconfirmed, the timesheet joins the normal approval flow.
    const pending = await tx.query(
      `SELECT 1 FROM attendance_events e WHERE e.booking_id = $1 AND e.status = 'pending_confirmation'
          AND NOT EXISTS (SELECT 1 FROM attendance_events c WHERE c.confirms_event_id = e.id AND c.status = 'accepted')`,
      [ev.booking_id],
    );
    if (!pending.rowCount) {
      const pol2 = await getPolicies(tx, ['timesheet.approval_window_hours']);
      await tx.query(
        `UPDATE timesheets SET status = 'pending_approval', approval_deadline = now() + make_interval(hours => $2)
          WHERE booking_id = $1 AND status = 'awaiting_confirmation'`,
        [ev.booking_id, pol2['timesheet.approval_window_hours']],
      );
    }
    await writeAudit(tx, { actorType: 'user', actorId: workerId, action: 'attendance.worker_confirmed', targetType: 'booking', targetId: ev.booking_id, ip });
    return { confirmed: true };
  });
}

/** Builds the timesheet from attendance. Called once, at check-out. Numbers are frozen after this. */
export async function createTimesheet(tx: Tx, bookingId: string, dataKey?: string) {
  const b = (await tx.query(
    `SELECT b.*, s.starts_at AS s_start, s.ends_at AS s_end, s.break_minutes, s.pay_type, s.pay_paise, s.meal_allowance_paise,
            s.travel_allowance_paise, s.cost, s.business_id
       FROM bookings b JOIN shifts s ON s.id = b.shift_id WHERE b.id = $1`,
    [bookingId],
  )).rows[0];
  const events = (await tx.query(
    `SELECT * FROM attendance_events WHERE booking_id = $1 AND status <> 'rejected' AND type <> 'worker_confirm' ORDER BY effective_at`,
    [bookingId],
  )).rows;
  const checkIn = events.find((e) => e.type === 'check_in');
  const checkOut = events.find((e) => e.type === 'check_out');
  if (!checkIn || !checkOut) throw new Error('timesheet needs a check-in and a check-out');
  const breaks: { start: Date; end: Date | null }[] = [];
  for (const e of events) {
    if (e.type === 'break_start') breaks.push({ start: e.effective_at, end: null });
    if (e.type === 'break_end' && breaks.length && !breaks[breaks.length - 1]!.end) breaks[breaks.length - 1]!.end = e.effective_at;
  }
  const pol = await getPolicies(tx, ['overtime.multiplier_bp', 'timesheet.approval_window_hours', 'attendance.late_checkout_flag_min', 'attendance.left_site_flag_min']);
  const ot = (await tx.query(`SELECT COALESCE(sum(extra_minutes), 0)::int AS m, max(multiplier_bp) AS bp FROM overtime_requests WHERE booking_id = $1 AND status = 'accepted'`, [bookingId])).rows[0];
  const calc = computeTimesheet(
    { scheduledStart: b.s_start, scheduledEnd: b.s_end, postedBreakMinutes: b.break_minutes, checkIn: checkIn.effective_at, checkOut: checkOut.effective_at, breaks, acceptedOvertimeMinutes: ot.m },
    { payType: b.pay_type, payPaise: Number(b.pay_paise), mealAllowancePaise: Number(b.meal_allowance_paise), travelAllowancePaise: Number(b.travel_allowance_paise), overtimeMultiplierBp: ot.bp ?? pol['overtime.multiplier_bp'] },
  );
  const flags = new Set<string>(events.flatMap((e) => e.flags as string[]));
  if (calc.stayedLateMinutes >= pol['attendance.late_checkout_flag_min']) flags.add('stayed_late_no_overtime');
  const absent = (await tx.query(
    `SELECT count(*)::int AS n FROM attendance_pings WHERE booking_id = $1 AND NOT inside`, [bookingId])).rows[0].n;
  if (absent > 0) flags.add('location_pings_outside_site');
  const manual = events.some((e) => e.mode === 'offline_supervisor');
  const r = await tx.query(
    `INSERT INTO timesheets (booking_id, shift_id, business_id, worker_id, started_at, ended_at, break_minutes, payable_minutes, overtime_minutes,
        base_pay_paise, overtime_pay_paise, allowances_paise, gross_paise, fee_bp, gst_bp, flags, status, approval_deadline)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, now() + make_interval(hours => $18)) RETURNING *`,
    [bookingId, b.shift_id, b.business_id, b.worker_id, calc.startedAt, calc.endedAt, calc.breakMinutes, calc.payableMinutes, calc.overtimeMinutes,
     calc.basePayPaise, calc.overtimePayPaise, calc.allowancesPaise, calc.grossPaise, b.cost.feeBp, b.cost.gstBp, [...flags],
     manual ? 'awaiting_confirmation' : 'pending_approval', pol['timesheet.approval_window_hours']],
  );
  if (!manual && dataKey) {
    const w = (await tx.query('SELECT p.first_name, s.title FROM worker_profiles p, shifts s WHERE p.user_id = $1 AND s.id = $2', [b.worker_id, b.shift_id])).rows[0];
    await notifyBusiness(tx, { dataKey }, b.business_id, 'timesheet_pending', { name: w.first_name, title: w.title, hours: pol['timesheet.approval_window_hours'] }, `ts:${r.rows[0].id}`);
  }
  return r.rows[0];
}
