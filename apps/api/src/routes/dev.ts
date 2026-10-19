import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { lookupHash, normalizeIndianPhone } from '@shiftkart/shared';
import type { AppDeps } from '../app';
import { parse } from '../lib/validate';
import { notFound } from '../lib/errors';
import { runJobsOnce } from '../jobs';

const Search = z.object({ phone: z.string().max(20).optional() }).strict();

/** Dev-only: read the mock SMS outbox to get OTP codes. Never registered in production. */
export async function devRoutes(app: FastifyInstance, { db, config, sms, payouts }: AppDeps) {
  app.post('/dev/outbox', { config: { auth: { public: true } } }, async (req) => {
    const { phone } = parse(Search, req.body);
    const n = phone ? normalizeIndianPhone(phone) : null;
    const r = await db.query(
      `SELECT channel, to_masked, body, created_at FROM dev_outbox
        WHERE ($1::text IS NULL OR to_hash = $1) ORDER BY created_at DESC LIMIT 20`,
      [n ? lookupHash(n, config.hashKey) : null],
    );
    return r.rows.map((m) => ({ channel: m.channel, to: m.to_masked, body: m.body, at: m.created_at }));
  });

  /** Run the background jobs now (payouts, auto-approval, settlement) instead of waiting 15 s. */
  app.post('/dev/jobs/run', { config: { auth: { public: true } } }, async () => runJobsOnce({ db, sms, payouts, dataKey: config.dataKey }));

  /**
   * Time travel for trying check-in by hand: moves a live test shift (and its bookings) so it starts
   * `minutes` from now (default: started 5 minutes ago). Local development database only.
   */
  app.post('/dev/shifts/:shiftId/start-now', { config: { auth: { public: true } } }, async (req) => {
    const { shiftId } = parse(z.object({ shiftId: z.string().uuid() }).strict(), req.params);
    const { minutes } = parse(z.object({ minutes: z.number().int().min(-720).max(720).default(-5) }).strict(), req.body);
    const r = await db.query(
      `WITH s AS (SELECT id, starts_at FROM shifts WHERE id = $1 AND status = 'live')
       UPDATE shifts SET starts_at = now() + make_interval(mins => $2), ends_at = now() + make_interval(mins => $2) + (ends_at - starts_at)
        WHERE id IN (SELECT id FROM s) RETURNING starts_at, ends_at`,
      [shiftId, minutes],
    );
    if (!r.rowCount) throw notFound('No live shift with that id.');
    await db.query(
      `UPDATE bookings SET starts_at = $2, ends_at = $3, slot_window = tstzrange($2::timestamptz - (upper(slot_window) - ends_at), $3::timestamptz + (upper(slot_window) - ends_at), '[)')
        WHERE shift_id = $1`,
      [shiftId, r.rows[0].starts_at, r.rows[0].ends_at],
    );
    return { startsAt: r.rows[0].starts_at, endsAt: r.rows[0].ends_at };
  });
}
