import type { Db, Tx } from './db';
import { withTx } from './db';
import type { SmsSender } from './adapters/sms';
import { notify } from './notify/notify';
import { getPolicies, getPolicy } from './policy';
import { assertNoInterimHold } from './removal';
import { HttpError, conflict, forbidden } from './lib/errors';
import { assertNotOnHold } from './trust';
import { assertNoSelfDealing } from './fraud-rules';

export type ShiftRow = {
  id: string; business_id: string; site_id: string; status: string; starts_at: Date; ends_at: Date;
  headcount: number; filled_count: number; requirements: { skills?: string[]; languages?: string[]; twoWheeler?: boolean };
};

export type Eligibility = { eligible: boolean; missing: string[] };

export function eligibility(
  worker: { skills: string[]; languages: string[]; has_two_wheeler: boolean },
  req: ShiftRow['requirements'],
): Eligibility {
  const missing: string[] = [];
  for (const s of req.skills ?? []) if (!worker.skills.includes(s)) missing.push(`skill:${s}`);
  if (req.languages?.length && !req.languages.some((l) => worker.languages.includes(l))) missing.push(`language:${req.languages.join('|')}`);
  if (req.twoWheeler && !worker.has_two_wheeler) missing.push('two_wheeler');
  return { eligible: missing.length === 0, missing };
}

/**
 * All checks that don't depend on slot availability. Locks the worker's profile row first,
 * so two parallel accepts by the same worker are serialised and can't both slip under a cap.
 */
async function checkWorkerCanBook(tx: Tx, workerId: string, shift: ShiftRow) {
  const w = (await tx.query(
    `SELECT p.*, u.status AS user_status FROM worker_profiles p JOIN users u ON u.id = p.user_id
      WHERE p.user_id = $1 FOR UPDATE OF p`,
    [workerId],
  )).rows[0];
  if (!w || w.verification_status !== 'verified') throw forbidden('Finish verification before accepting shifts.');
  if (w.user_status === 'suspended' || w.user_status === 'deleted') throw forbidden();
  await assertNoInterimHold(tx, workerId);

  const elig = eligibility(w, shift.requirements);
  if (!elig.eligible) throw new HttpError(403, 'not_eligible', `This shift needs: ${elig.missing.join(', ')}`);

  const pol = await getPolicies(tx, ['booking.max_hours_day', 'booking.max_hours_week', 'booking.max_future_new_worker', 'booking.max_future_established', 'booking.established_after_shifts']);
  const maxDay = pol['booking.max_hours_day'], maxWeek = pol['booking.max_hours_week'];
  const maxNew = pol['booking.max_future_new_worker'], maxEst = pol['booking.max_future_established'], estAfter = pol['booking.established_after_shifts'];
  const usage = (await tx.query(
    `SELECT
       COALESCE(sum(EXTRACT(EPOCH FROM ends_at - starts_at) / 60) FILTER (
         WHERE (starts_at AT TIME ZONE 'Asia/Kolkata')::date = ($2::timestamptz AT TIME ZONE 'Asia/Kolkata')::date), 0)::int AS day_min,
       COALESCE(sum(EXTRACT(EPOCH FROM ends_at - starts_at) / 60) FILTER (
         WHERE date_trunc('week', starts_at AT TIME ZONE 'Asia/Kolkata') = date_trunc('week', $2::timestamptz AT TIME ZONE 'Asia/Kolkata')), 0)::int AS week_min,
       count(*) FILTER (WHERE starts_at > now() AND status = 'confirmed')::int AS future
     FROM bookings WHERE worker_id = $1 AND status IN ('confirmed', 'checked_in', 'completed')`,
    [workerId, shift.starts_at],
  )).rows[0];
  const shiftMin = (shift.ends_at.getTime() - shift.starts_at.getTime()) / 60_000;
  if (usage.day_min + shiftMin > maxDay * 60) throw conflict('daily_hours_cap', `That would take you over ${maxDay} hours that day.`);
  if (usage.week_min + shiftMin > maxWeek * 60) throw conflict('weekly_hours_cap', `That would take you over ${maxWeek} hours that week.`);
  // Strikes: "limited" can hold one upcoming shift, "on hold" none (until a person reviews). New workers a few; established more (WRK-08).
  const strikes = await assertNotOnHold(tx, workerId);
  const cap = w.user_status === 'limited' || strikes.level === 'limited' ? 1 : w.completed_shifts >= estAfter ? maxEst : maxNew;
  if (usage.future >= cap) throw conflict('too_many_bookings', `You can hold up to ${cap} upcoming shifts. Finish or cancel one first.`);
}

async function insertBooking(tx: Tx, workerId: string, shift: ShiftRow, source: 'direct' | 'waitlist', nightConsent = false) {
  const restGapHours = await getPolicy<number>(tx, 'booking.rest_gap_hours');
  try {
    const r = await tx.query(
      `INSERT INTO bookings (shift_id, worker_id, status, source, starts_at, ends_at, slot_window, night_consent_at)
       VALUES ($1, $2, 'confirmed', $3, $4, $5,
               tstzrange($4::timestamptz - make_interval(mins => $6), $5::timestamptz + make_interval(mins => $6), '[)'),
               CASE WHEN $7 THEN now() END)
       RETURNING id, status, starts_at, ends_at`,
      [shift.id, workerId, source, shift.starts_at, shift.ends_at, Math.round((restGapHours * 60) / 2), nightConsent],
    );
    return r.rows[0] as { id: string; status: string; starts_at: Date; ends_at: Date };
  } catch (e) {
    const code = (e as { code?: string }).code;
    // SYS-02: the database refuses overlapping shifts or too little rest, even under races.
    if (code === '23P01') throw conflict('overlap_or_rest_gap', `This overlaps another shift or leaves less than ${restGapHours} hours of rest.`);
    if (code === '23505') throw conflict('already_booked', 'You already have this shift.');
    throw e;
  }
}

/**
 * SYS-01: takes the last slot safely. The conditional UPDATE only succeeds while a slot is free,
 * Postgres serialises concurrent updates on the row, and a CHECK constraint backs it up.
 */
export async function acceptShift(db: Db, workerId: string, shiftId: string, opts: { nightConsent?: boolean } = {}) {
  // MON-01 runs outside the booking transaction so its fraud flag survives the refusal.
  const owner = (await db.query('SELECT business_id FROM shifts WHERE id = $1', [shiftId])).rows[0];
  if (owner) await assertNoSelfDealing(db, workerId, owner.business_id);
  return withTx(db, async (tx) => {
    const shift = (await tx.query('SELECT * FROM shifts WHERE id = $1', [shiftId])).rows[0] as ShiftRow & { is_night: boolean; business_id: string } | undefined;
    if (!shift || shift.status !== 'live' || shift.starts_at <= new Date()) throw new HttpError(404, 'not_found', 'This shift is no longer available.');
    const blocked = await tx.query('SELECT 1 FROM worker_blocks WHERE worker_id = $1 AND business_id = $2', [workerId, shift.business_id]);
    if (blocked.rowCount) throw new HttpError(404, 'not_found', 'This shift is no longer available.');
    // Night shifts: the worker sees the timing and the transport the business promised, and agrees explicitly.
    if (shift.is_night && !opts.nightConsent) throw conflict('night_consent_required', 'This is a night shift. Please confirm you agree to the timing and transport arrangement.');
    await checkWorkerCanBook(tx, workerId, shift);
    const upd = await tx.query(
      `UPDATE shifts SET filled_count = filled_count + 1
        WHERE id = $1 AND status = 'live' AND starts_at > now() AND filled_count < headcount RETURNING *`,
      [shiftId],
    );
    if (!upd.rowCount) throw conflict('shift_full', 'All slots are taken. You can join the waitlist.');
    return insertBooking(tx, workerId, upd.rows[0], 'direct', Boolean(opts.nightConsent));
  });
}

async function offerTtlMinutes(tx: Tx, startsAt: Date): Promise<number> {
  const pol = await getPolicies(tx, ['waitlist.offer_ttl_min', 'waitlist.offer_ttl_short_min', 'waitlist.short_window_hours']);
  const normal = pol['waitlist.offer_ttl_min'], short = pol['waitlist.offer_ttl_short_min'], window = pol['waitlist.short_window_hours'];
  const minsToStart = (startsAt.getTime() - Date.now()) / 60_000;
  return Math.max(1, Math.min(minsToStart < window * 60 ? short : normal, Math.floor(minsToStart)));
}

/**
 * A slot has opened on a shift whose row the caller has locked. Offer it to the next person on the
 * waitlist (the offer holds the slot), or release it back to open booking.
 */
export async function offerNextOrRelease(tx: Tx, shiftId: string, sms?: SmsSender, dataKey?: string): Promise<'offered' | 'released'> {
  const shift = (await tx.query('SELECT * FROM shifts WHERE id = $1', [shiftId])).rows[0] as ShiftRow;
  if (shift.status === 'live' && shift.starts_at.getTime() - Date.now() > 60_000) {
    const next = (await tx.query(
      `SELECT w.id, w.worker_id, u.phone_enc FROM waitlist_entries w JOIN users u ON u.id = w.worker_id
        WHERE w.shift_id = $1 AND w.status = 'waiting' ORDER BY w.position LIMIT 1 FOR UPDATE OF w SKIP LOCKED`,
      [shiftId],
    )).rows[0];
    if (next) {
      const ttl = await offerTtlMinutes(tx, shift.starts_at);
      await tx.query(
        `UPDATE waitlist_entries SET status = 'offered', offered_at = now(), offer_expires_at = now() + make_interval(mins => $2) WHERE id = $1`,
        [next.id, ttl],
      );
      if (dataKey) {
        const title = (await tx.query('SELECT title FROM shifts WHERE id = $1', [shiftId])).rows[0].title;
        await notify(tx, { dataKey }, { userId: next.worker_id, template: 'waitlist_offer', vars: { title, minutes: ttl }, dedupeKey: `offer:${next.id}:${Date.now()}` });
      }
      return 'offered';
    }
  }
  await tx.query('UPDATE shifts SET filled_count = filled_count - 1 WHERE id = $1 AND filled_count > 0', [shiftId]);
  return 'released';
}

export async function joinWaitlist(db: Db, workerId: string, shiftId: string) {
  return withTx(db, async (tx) => {
    const shift = (await tx.query('SELECT * FROM shifts WHERE id = $1 FOR UPDATE', [shiftId])).rows[0] as ShiftRow | undefined;
    if (!shift || shift.status !== 'live' || shift.starts_at <= new Date()) throw new HttpError(404, 'not_found', 'This shift is no longer available.');
    if (shift.filled_count < shift.headcount) throw conflict('slots_available', 'There are free slots. Accept the shift directly.');
    const w = (await tx.query('SELECT * FROM worker_profiles WHERE user_id = $1', [workerId])).rows[0];
    if (!w || w.verification_status !== 'verified') throw forbidden('Finish verification first.');
    const elig = eligibility(w, shift.requirements);
    if (!elig.eligible) throw new HttpError(403, 'not_eligible', `This shift needs: ${elig.missing.join(', ')}`);
    const booked = await tx.query(`SELECT 1 FROM bookings WHERE shift_id = $1 AND worker_id = $2 AND status = 'confirmed'`, [shiftId, workerId]);
    if (booked.rowCount) throw conflict('already_booked', 'You already have this shift.');
    const r = await tx.query(
      `INSERT INTO waitlist_entries (shift_id, worker_id) VALUES ($1, $2)
       ON CONFLICT (shift_id, worker_id) DO UPDATE SET status = 'waiting', offered_at = NULL, offer_expires_at = NULL
         WHERE waitlist_entries.status IN ('left', 'declined', 'expired')
       RETURNING id, status`,
      [shiftId, workerId],
    );
    if (!r.rowCount) throw conflict('already_waitlisted', 'You are already on the waitlist.');
    const ahead = await tx.query(
      `SELECT count(*)::int AS n FROM waitlist_entries WHERE shift_id = $1 AND status = 'waiting' AND position < (SELECT position FROM waitlist_entries WHERE id = $2)`,
      [shiftId, r.rows[0].id],
    );
    return { id: r.rows[0].id as string, status: r.rows[0].status as string, peopleAhead: ahead.rows[0].n as number };
  });
}

/** SYS-09: an offer is bound to one worker and checked against its expiry inside the transaction. */
export async function respondToOffer(db: Db, workerId: string, entryId: string, accept: boolean, sms: SmsSender, dataKey: string) {
  const outcome = await withTx(db, async (tx) => {
    const e0 = (await tx.query('SELECT shift_id FROM waitlist_entries WHERE id = $1 AND worker_id = $2', [entryId, workerId])).rows[0];
    if (!e0) throw new HttpError(404, 'not_found', 'Offer not found.');
    // Lock order everywhere: worker profile, then shift, then waitlist entry (no deadlocks).
    await tx.query('SELECT 1 FROM worker_profiles WHERE user_id = $1 FOR UPDATE', [workerId]);
    const shift = (await tx.query('SELECT * FROM shifts WHERE id = $1 FOR UPDATE', [e0.shift_id])).rows[0] as ShiftRow;
    const entry = (await tx.query('SELECT * FROM waitlist_entries WHERE id = $1 FOR UPDATE', [entryId])).rows[0];
    if (entry.status !== 'offered') throw conflict('no_offer', 'There is no open offer for you on this shift.');
    if (entry.offer_expires_at <= new Date()) {
      await tx.query(`UPDATE waitlist_entries SET status = 'expired' WHERE id = $1`, [entryId]);
      await offerNextOrRelease(tx, shift.id, sms, dataKey);
      return { error: conflict('offer_expired', 'This offer has expired.') };
    }
    if (!accept) {
      await tx.query(`UPDATE waitlist_entries SET status = 'declined' WHERE id = $1`, [entryId]);
      await offerNextOrRelease(tx, shift.id, sms, dataKey);
      return { declined: true as const };
    }
    // The offer already holds the slot, so no filled_count change. If this worker can't take it
    // (overlap, caps), the slot passes to the next person instead of being lost.
    await tx.query('SAVEPOINT book');
    try {
      await checkWorkerCanBook(tx, workerId, shift);
      const booking = await insertBooking(tx, workerId, shift, 'waitlist');
      await tx.query(`UPDATE waitlist_entries SET status = 'accepted' WHERE id = $1`, [entryId]);
      return { booking };
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      await tx.query('ROLLBACK TO SAVEPOINT book');
      await tx.query(`UPDATE waitlist_entries SET status = 'declined' WHERE id = $1`, [entryId]);
      await offerNextOrRelease(tx, shift.id, sms, dataKey);
      return { error: err };
    }
  });
  if ('error' in outcome) throw outcome.error;
  return outcome;
}

/** Worker cancels. Strikes for late cancellation arrive in Phase 4; the hours-before is recorded now. */
export async function cancelBookingByWorker(db: Db, workerId: string, bookingId: string, sms: SmsSender, dataKey: string) {
  return withTx(db, async (tx) => {
    const b0 = (await tx.query('SELECT shift_id FROM bookings WHERE id = $1 AND worker_id = $2', [bookingId, workerId])).rows[0];
    if (!b0) throw new HttpError(404, 'not_found', 'Booking not found.');
    await tx.query('SELECT 1 FROM shifts WHERE id = $1 FOR UPDATE', [b0.shift_id]);
    const b = (await tx.query(
      `UPDATE bookings SET status = 'cancelled_worker', cancelled_at = now(),
              cancel_hours_before = round((EXTRACT(EPOCH FROM starts_at - now()) / 3600)::numeric, 2)
        WHERE id = $1 AND status = 'confirmed' AND starts_at > now() RETURNING *`,
      [bookingId],
    )).rows[0];
    if (!b) throw conflict('not_cancellable', 'This booking can no longer be cancelled here.');
    const slot = await offerNextOrRelease(tx, b.shift_id, sms, dataKey);
    return { id: b.id, status: b.status, hoursBefore: Number(b.cancel_hours_before), slot };
  });
}

/** Expires stale offers and passes the slot on. Runs every 30 s from the API process. */
export async function sweepExpiredOffers(db: Db, sms?: SmsSender, dataKey?: string): Promise<number> {
  const due = await db.query(`SELECT id, shift_id FROM waitlist_entries WHERE status = 'offered' AND offer_expires_at <= now() LIMIT 100`);
  let n = 0;
  for (const row of due.rows) {
    await withTx(db, async (tx) => {
      await tx.query('SELECT 1 FROM shifts WHERE id = $1 FOR UPDATE', [row.shift_id]);
      const r = await tx.query(
        `UPDATE waitlist_entries SET status = 'expired' WHERE id = $1 AND status = 'offered' AND offer_expires_at <= now() RETURNING id`,
        [row.id],
      );
      if (r.rowCount) { n += 1; await offerNextOrRelease(tx, row.shift_id, sms, dataKey); }
    });
  }
  return n;
}
