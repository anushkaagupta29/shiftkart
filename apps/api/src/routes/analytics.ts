import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app';
import { parse } from '../lib/validate';

// Operational dashboards (SPEC §6.11). Aggregates only: no names, phones or ids leave this
// endpoint (analytics never carry personal data, SPEC §6.12). Days are IST calendar days.
const Q = z.object({ days: z.coerce.number().int().min(7).max(180).default(30), city: z.string().regex(/^[A-Z]{3}$/).optional() }).strict();

const ratio = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);

export async function analyticsRoutes(app: FastifyInstance, { db }: AppDeps) {
  app.get('/admin/analytics', { config: { auth: { staff: 'any' } } }, async (req) => {
    const { days, city } = parse(Q, req.query);
    const p = [days, city ?? null];
    const shiftDays = (await db.query(
      `WITH s AS (
         SELECT s.*, (s.starts_at AT TIME ZONE 'Asia/Kolkata')::date AS d FROM shifts s JOIN sites si ON si.id = s.site_id
          WHERE s.published_at IS NOT NULL AND s.starts_at >= now() - make_interval(days => $1) AND s.starts_at < now() + interval '1 day'
            AND ($2::text IS NULL OR si.city_code = $2))
       SELECT s.d,
              sum(s.headcount)::int AS slots,
              (SELECT count(*) FROM bookings b WHERE b.shift_id = ANY(array_agg(s.id)) AND b.status IN ('confirmed', 'checked_in', 'completed', 'no_show', 'turned_away'))::int AS filled,
              (SELECT count(*) FROM bookings b WHERE b.shift_id = ANY(array_agg(s.id)) AND b.status = 'no_show')::int AS no_show,
              (SELECT count(*) FROM bookings b WHERE b.shift_id = ANY(array_agg(s.id)) AND b.status IN ('completed', 'no_show', 'turned_away', 'checked_in'))::int AS due,
              (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM f.filled_at - f.published_at) / 60) FROM (
                 SELECT x.published_at, (SELECT max(b.created_at) FROM bookings b WHERE b.shift_id = x.id) AS filled_at
                   FROM shifts x WHERE x.id = ANY(array_agg(s.id))
                    AND (SELECT count(*) FROM bookings b WHERE b.shift_id = x.id AND b.status <> 'cancelled_worker') >= x.headcount) f) AS ttf
         FROM s GROUP BY s.d ORDER BY s.d`, p)).rows;
    const payoutDays = (await db.query(
      `SELECT (p.paid_at AT TIME ZONE 'Asia/Kolkata')::date AS d,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM p.paid_at - p.approved_at) / 60) AS p50,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM p.paid_at - p.approved_at) / 60) AS p95
         FROM payouts p WHERE p.status = 'paid' AND p.kind = 'wage' AND p.paid_at >= now() - make_interval(days => $1)
          AND ($2::text IS NULL OR EXISTS (SELECT 1 FROM timesheets t JOIN shifts s ON s.id = t.shift_id JOIN sites si ON si.id = s.site_id WHERE t.id = p.timesheet_id AND si.city_code = $2))
        GROUP BY 1 ORDER BY 1`, p)).rows;
    const disputeDays = (await db.query(
      `SELECT (t.created_at AT TIME ZONE 'Asia/Kolkata')::date AS d, count(*)::int AS n, count(*) FILTER (WHERE t.disputed_at IS NOT NULL)::int AS disputed
         FROM timesheets t JOIN shifts s ON s.id = t.shift_id JOIN sites si ON si.id = s.site_id
        WHERE t.created_at >= now() - make_interval(days => $1) AND ($2::text IS NULL OR si.city_code = $2) GROUP BY 1 ORDER BY 1`, p)).rows;
    const flagDays = (await db.query(
      `SELECT (created_at AT TIME ZONE 'Asia/Kolkata')::date AS d, count(*)::int AS n FROM fraud_flags WHERE created_at >= now() - make_interval(days => $1) GROUP BY 1 ORDER BY 1`, [days])).rows;
    const flagsByRule = (await db.query(
      `SELECT rule_code AS rule, count(*)::int AS count, count(*) FILTER (WHERE status = 'open')::int AS open FROM fraud_flags
        WHERE created_at >= now() - make_interval(days => $1) GROUP BY rule_code ORDER BY count DESC LIMIT 12`, [days])).rows;
    const overall = (await db.query(
      `SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM paid_at - approved_at) / 60) AS p50,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM paid_at - approved_at) / 60) AS p95,
              count(*) FILTER (WHERE paid_at - approved_at > interval '24 hours')::int AS late, count(*)::int AS n
         FROM payouts WHERE status = 'paid' AND kind = 'wage' AND paid_at >= now() - make_interval(days => $1)`, [days])).rows[0];

    const key = (d: Date) => new Date(d).toISOString().slice(0, 10);
    const byDay = new Map<string, Record<string, number | null>>();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.now() + 330 * 60_000 - i * 86400_000).toISOString().slice(0, 10);
      byDay.set(d, { fillRate: null, noShowRate: null, timeToFillMin: null, payoutDelayP50Min: null, disputeRate: null, fraudFlags: 0 });
    }
    const put = (d: Date, k: string, v: number | null) => { const row = byDay.get(key(d)); if (row) row[k] = v; };
    for (const r of shiftDays) { put(r.d, 'fillRate', ratio(r.filled, r.slots)); put(r.d, 'noShowRate', ratio(r.no_show, r.due)); put(r.d, 'timeToFillMin', r.ttf == null ? null : Math.round(r.ttf)); }
    for (const r of payoutDays) put(r.d, 'payoutDelayP50Min', Math.round(r.p50));
    for (const r of disputeDays) put(r.d, 'disputeRate', ratio(r.disputed, r.n));
    for (const r of flagDays) put(r.d, 'fraudFlags', r.n);

    const sum = (k: string) => shiftDays.reduce((a, r) => a + Number(r[k] ?? 0), 0);
    const ttfs = shiftDays.map((r) => r.ttf).filter((x) => x != null).map(Number).sort((a, b) => a - b);
    return {
      days, city: city ?? null,
      kpis: {
        fillRate: ratio(sum('filled'), sum('slots')),
        noShowRate: ratio(sum('no_show'), sum('due')),
        medianTimeToFillMin: ttfs.length ? Math.round(ttfs[Math.floor(ttfs.length / 2)]!) : null,
        payoutDelayP50Min: overall.p50 == null ? null : Math.round(overall.p50),
        payoutDelayP95Min: overall.p95 == null ? null : Math.round(overall.p95),
        payoutsOver24h: overall.late,
        disputeRate: ratio(disputeDays.reduce((a, r) => a + r.disputed, 0), disputeDays.reduce((a, r) => a + r.n, 0)),
        fraudFlags: flagDays.reduce((a, r) => a + r.n, 0),
      },
      daily: [...byDay.entries()].map(([date, v]) => ({ date, ...v })),
      flagsByRule,
    };
  });
}
