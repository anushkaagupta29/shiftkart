import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app';
import { parse } from '../lib/validate';
import { notFound } from '../lib/errors';
import { userActor } from '../auth/guard';
import { acceptShift, cancelBookingByWorker, eligibility, joinWaitlist, respondToOffer } from '../booking';

const workerAuth = { auth: { user: { kinds: ['worker' as const] } } };
export const ACCEPT_ATTEMPTS_PER_MIN = 10;
const IdParam = z.object({ id: z.string().uuid() }).strict();

// Location goes in the body, not the URL, so it never lands in access logs.
const Search = z.object({
  lat: z.number().min(6).max(37).optional(),
  lng: z.number().min(68).max(98).optional(),
  radiusKm: z.number().int().min(1).max(50).optional(),
}).strict();

const SHIFT_COLUMNS = `
  s.id, s.title, s.description, s.role_code, r.name_i18n AS role_name, s.starts_at, s.ends_at, s.break_minutes,
  s.headcount, s.filled_count, s.pay_type, s.pay_paise, s.meal_allowance_paise, s.travel_allowance_paise,
  s.requirements, s.dress_code, s.bring_items, s.cost, s.status,
  COALESCE(b.trade_name, b.legal_name) AS business_name, si.name AS site_name, si.address,
  ST_Y(si.location::geometry) AS lat, ST_X(si.location::geometry) AS lng`;

/** Everything a worker needs up front: full pay, place and timing. No hidden details. */
function workerShiftView(s: Record<string, any>, worker?: Record<string, any>) {
  const elig = worker ? eligibility(worker as never, s.requirements) : { eligible: false, missing: ['profile'] };
  return {
    id: s.id, title: s.title, description: s.description, role: { code: s.role_code, name: s.role_name },
    businessName: s.business_name, siteName: s.site_name, address: s.address, lat: s.lat, lng: s.lng,
    distanceKm: s.dist_m != null ? Math.round(s.dist_m / 100) / 10 : undefined,
    startsAt: s.starts_at, endsAt: s.ends_at, breakMinutes: s.break_minutes,
    pay: {
      type: s.pay_type, ratePaise: s.pay_paise, hourlyPaise: s.cost.effectiveHourlyPaise,
      totalPaise: s.cost.perWorkerPayPaise, mealAllowancePaise: s.meal_allowance_paise, travelAllowancePaise: s.travel_allowance_paise,
      takeHomePaise: s.cost.perWorkerPayPaise + s.cost.perWorkerAllowancesPaise,
    },
    slotsLeft: Math.max(0, s.headcount - s.filled_count), headcount: s.headcount,
    requirements: s.requirements, dressCode: s.dress_code, bringItems: s.bring_items,
    eligible: elig.eligible, missing: elig.missing,
    myWaitlist: s.wl_status ? { id: s.wl_id, status: s.wl_status, expiresAt: s.wl_expires } : null,
  };
}

export async function workerShiftRoutes(app: FastifyInstance, { db, sms, config }: AppDeps) {
  app.post('/worker/shifts/search', { config: workerAuth }, async (req) => {
    const a = userActor(req);
    const q = parse(Search, req.body);
    const w = (await db.query(
      `SELECT p.*, ST_Y(p.home_point::geometry) AS hlat, ST_X(p.home_point::geometry) AS hlng FROM worker_profiles p WHERE user_id = $1`,
      [a.userId],
    )).rows[0];
    const blr = (await db.query(`SELECT ST_Y(center::geometry) AS lat, ST_X(center::geometry) AS lng FROM cities WHERE code = 'BLR'`)).rows[0];
    const lat = q.lat ?? w?.hlat ?? blr.lat;
    const lng = q.lng ?? w?.hlng ?? blr.lng;
    const radiusKm = q.radiusKm ?? w?.travel_radius_km ?? 10;
    const r = await db.query(
      `SELECT ${SHIFT_COLUMNS}, ST_Distance(si.location, ST_MakePoint($2, $3)::geography) AS dist_m,
              wl.id AS wl_id, wl.status AS wl_status, wl.offer_expires_at AS wl_expires
         FROM shifts s
         JOIN sites si ON si.id = s.site_id
         JOIN businesses b ON b.id = s.business_id
         JOIN role_categories r ON r.code = s.role_code
         LEFT JOIN waitlist_entries wl ON wl.shift_id = s.id AND wl.worker_id = $1 AND wl.status IN ('waiting', 'offered')
        WHERE s.status = 'live' AND s.starts_at > now() AND si.status = 'active' AND b.verification_status = 'verified'
          AND ST_DWithin(si.location, ST_MakePoint($2, $3)::geography, $4 * 1000)
          AND NOT EXISTS (SELECT 1 FROM bookings bk WHERE bk.shift_id = s.id AND bk.worker_id = $1 AND bk.status = 'confirmed')
        ORDER BY s.starts_at LIMIT 50`,
      [a.userId, lng, lat, radiusKm],
    );
    const items = r.rows.map((s) => workerShiftView(s, w));
    // Once the profile is done, only shifts the worker actually qualifies for are shown.
    return { items: w?.profile_completed_at ? items.filter((s) => s.eligible) : items, radiusKm };
  });

  app.get('/worker/shifts/:id', { config: workerAuth }, async (req) => {
    const a = userActor(req);
    const { id } = parse(IdParam, req.params);
    const s = (await db.query(
      `SELECT ${SHIFT_COLUMNS}, wl.id AS wl_id, wl.status AS wl_status, wl.offer_expires_at AS wl_expires
         FROM shifts s JOIN sites si ON si.id = s.site_id JOIN businesses b ON b.id = s.business_id JOIN role_categories r ON r.code = s.role_code
         LEFT JOIN waitlist_entries wl ON wl.shift_id = s.id AND wl.worker_id = $2 AND wl.status IN ('waiting', 'offered')
        WHERE s.id = $1 AND (s.status = 'live' OR EXISTS (SELECT 1 FROM bookings bk WHERE bk.shift_id = s.id AND bk.worker_id = $2))`,
      [id, a.userId],
    )).rows[0];
    if (!s) throw notFound();
    const w = (await db.query('SELECT * FROM worker_profiles WHERE user_id = $1', [a.userId])).rows[0];
    return workerShiftView(s, w);
  });

  // WRK-09: per-worker accept limit, on top of the global per-IP limit. A code constant, not a
  // policy value, because the rate limiter is configured once at startup.
  const acceptLimit = {
    max: ACCEPT_ATTEMPTS_PER_MIN,
    timeWindow: '1 minute',
    keyGenerator: (req: { headers: Record<string, unknown>; ip: string }) => String(req.headers.authorization ?? req.headers.cookie ?? req.ip),
  };

  app.post('/worker/shifts/:id/accept', { config: { ...workerAuth, rateLimit: acceptLimit } }, async (req, reply) => {
    const a = userActor(req);
    const { id } = parse(IdParam, req.params);
    const b = await acceptShift(db, a.userId, id);
    reply.code(201);
    return { bookingId: b.id, status: b.status, startsAt: b.starts_at, endsAt: b.ends_at };
  });

  app.post('/worker/shifts/:id/waitlist', { config: { ...workerAuth, rateLimit: acceptLimit } }, async (req, reply) => {
    const a = userActor(req);
    const { id } = parse(IdParam, req.params);
    reply.code(201);
    return joinWaitlist(db, a.userId, id);
  });

  app.delete('/worker/shifts/:id/waitlist', { config: workerAuth }, async (req) => {
    const a = userActor(req);
    const { id } = parse(IdParam, req.params);
    const r = await db.query(
      `UPDATE waitlist_entries SET status = 'left' WHERE shift_id = $1 AND worker_id = $2 AND status = 'waiting' RETURNING id`,
      [id, a.userId],
    );
    if (!r.rowCount) throw notFound();
    return { ok: true };
  });

  app.get('/worker/bookings', { config: workerAuth }, async (req) => {
    const a = userActor(req);
    const r = await db.query(
      `SELECT bk.id AS booking_id, bk.status AS booking_status, bk.source, bk.cancelled_at, ${SHIFT_COLUMNS}
         FROM bookings bk JOIN shifts s ON s.id = bk.shift_id JOIN sites si ON si.id = s.site_id
         JOIN businesses b ON b.id = s.business_id JOIN role_categories r ON r.code = s.role_code
        WHERE bk.worker_id = $1 ORDER BY s.starts_at DESC LIMIT 100`,
      [a.userId],
    );
    return r.rows.map((s) => ({ bookingId: s.booking_id, bookingStatus: s.booking_status, source: s.source, cancelledAt: s.cancelled_at, shift: workerShiftView(s) }));
  });

  app.post('/worker/bookings/:id/cancel', { config: workerAuth }, async (req) => {
    const a = userActor(req);
    const { id } = parse(IdParam, req.params);
    return cancelBookingByWorker(db, a.userId, id, sms, config.dataKey);
  });

  app.get('/worker/offers', { config: workerAuth }, async (req) => {
    const a = userActor(req);
    const r = await db.query(
      `SELECT w.id, w.status, w.offer_expires_at, w.shift_id, s.title, s.starts_at FROM waitlist_entries w JOIN shifts s ON s.id = w.shift_id
        WHERE w.worker_id = $1 AND w.status IN ('waiting', 'offered') ORDER BY w.created_at DESC`,
      [a.userId],
    );
    return r.rows.map((o) => ({ id: o.id, status: o.status, expiresAt: o.offer_expires_at, shiftId: o.shift_id, title: o.title, startsAt: o.starts_at }));
  });

  app.post('/worker/offers/:id/accept', { config: { ...workerAuth, rateLimit: acceptLimit } }, async (req, reply) => {
    const a = userActor(req);
    const { id } = parse(IdParam, req.params);
    const r = await respondToOffer(db, a.userId, id, true, sms, config.dataKey);
    reply.code(201);
    return r;
  });

  app.post('/worker/offers/:id/decline', { config: workerAuth }, async (req) => {
    const a = userActor(req);
    const { id } = parse(IdParam, req.params);
    return respondToOffer(db, a.userId, id, false, sms, config.dataKey);
  });
}
