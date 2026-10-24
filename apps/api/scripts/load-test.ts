/**
 * Load test for shift acceptance (Phase 6). Local only: boots the API on 127.0.0.1 against the
 * TEST database (wiped first), creates workers straight in the DB, and fires real HTTP requests.
 *
 *   npm run load-test -w @shiftkart/api               # 1000 workers race for 50 slots, then a spread run and a feed run
 *   WORKERS=2000 SLOTS=100 npm run load-test -w @shiftkart/api
 *
 * It refuses to run against anything but a local database.
 */
import { performance } from 'node:perf_hooks';
import { loadRootEnv, requireEnv } from '@shiftkart/db';
import { closeApp, makeApp, resetData } from '../test/helpers';
import { bulkVerifiedWorkers, liveShift, seedRates, verifiedBusiness } from '../test/fixtures';

const WORKERS = Number(process.env.WORKERS ?? 1000);
const SLOTS = Number(process.env.SLOTS ?? 50);
const SPREAD_SHIFTS = Number(process.env.SPREAD_SHIFTS ?? 20);
const FEED_REQUESTS = Number(process.env.FEED_REQUESTS ?? 2000);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 200);

loadRootEnv();
const url = requireEnv('DATABASE_URL_TEST');
if (!/@(localhost|127\.0\.0\.1)[:/]/.test(url)) throw new Error('Load test runs against a local test database only.');

const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] ?? 0; };
const ms = (x: number) => `${x.toFixed(1)} ms`;

/** Runs `jobs` with at most `limit` in flight; returns per-request latency and status. */
async function blast(jobs: (() => Promise<Response>)[], limit: number) {
  const out: { ms: number; status: number; code?: string }[] = [];
  let next = 0;
  const t0 = performance.now();
  await Promise.all(Array.from({ length: Math.min(limit, jobs.length) }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++]!;
      const s = performance.now();
      const r = await job();
      const body = await r.json().catch(() => null) as { error?: { code?: string } } | null;
      out.push({ ms: performance.now() - s, status: r.status, code: body?.error?.code });
    }
  }));
  const wall = performance.now() - t0;
  const lat = out.map((o) => o.ms);
  const byCode: Record<string, number> = {};
  for (const o of out) { const k = o.status < 300 ? String(o.status) : `${o.status} ${o.code ?? ''}`.trim(); byCode[k] = (byCode[k] ?? 0) + 1; }
  return { n: out.length, wallMs: wall, rps: out.length / (wall / 1000), p50: pct(lat, 50), p95: pct(lat, 95), p99: pct(lat, 99), max: Math.max(...lat), byCode };
}

function report(name: string, r: Awaited<ReturnType<typeof blast>>) {
  console.log(`\n## ${name}`);
  console.log(`requests ${r.n} · wall ${ms(r.wallMs)} · ${r.rps.toFixed(0)} req/s`);
  console.log(`latency p50 ${ms(r.p50)} · p95 ${ms(r.p95)} · p99 ${ms(r.p99)} · max ${ms(r.max)}`);
  console.log(`responses ${JSON.stringify(r.byCode)}`);
}

async function main() {
  const ctx = await makeApp({ rateLimitPerMin: 1_000_000, otpGlobalHourly: 1_000_000 });
  const problems: string[] = [];
  try {
    await resetData(ctx.db);
    await seedRates(ctx);
    const biz = await verifiedBusiness(ctx);
    const base = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    console.log(`# ShiftKart load test · ${new Date().toISOString()} · node ${process.version} · ${WORKERS} workers · concurrency ${CONCURRENCY}`);

    const t = performance.now();
    const workers = await bulkVerifiedWorkers(ctx, WORKERS);
    console.log(`created ${WORKERS} verified workers in ${ms(performance.now() - t)}`);
    const post = (path: string, auth: { authorization: string }, body: unknown = {}) =>
      () => fetch(`${base}${path}`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });

    // 1. Everyone races for one popular shift.
    const hot = await liveShift(ctx, biz, { headcount: SLOTS, title: 'Hot shift' });
    const race = await blast(workers.map((w) => post(`/worker/shifts/${hot.id}/accept`, w.auth)), CONCURRENCY);
    report(`1. ${WORKERS} workers accept one shift with ${SLOTS} slots at the same moment`, race);
    const hotRow = (await ctx.db.query(`SELECT filled_count, (SELECT count(*)::int FROM bookings WHERE shift_id = $1 AND status = 'confirmed') AS booked FROM shifts WHERE id = $1`, [hot.id])).rows[0];
    console.log(`correctness: filled_count ${hotRow.filled_count}, confirmed bookings ${hotRow.booked}, expected ${SLOTS}`);
    if (hotRow.filled_count !== SLOTS || hotRow.booked !== SLOTS || race.byCode['201'] !== SLOTS) problems.push('race: overbooked or underbooked');
    if (Object.keys(race.byCode).some((k) => k.startsWith('5'))) problems.push('race: server errors');

    // 2. Many shifts, workers spread across them (normal busy morning). Uses the workers who lost the race.
    // Every worker tries once; the race winners already hold a shift at the same time, so they must be refused (overlap).
    const shifts: { id: string }[] = [];
    for (let i = 0; i < SPREAD_SHIFTS; i++) shifts.push(await liveShift(ctx, biz, { headcount: Math.ceil(WORKERS / SPREAD_SHIFTS), title: `Spread ${i}` }));
    const spread = await blast(workers.map((w, i) => post(`/worker/shifts/${shifts[i % SPREAD_SHIFTS]!.id}/accept`, w.auth)), CONCURRENCY);
    report(`2. ${WORKERS} accepts spread over ${SPREAD_SHIFTS} shifts`, spread);
    const over = (await ctx.db.query(`SELECT count(*)::int AS n FROM shifts WHERE filled_count > headcount`)).rows[0].n;
    const doubles = (await ctx.db.query(
      `SELECT count(*)::int AS n FROM bookings a JOIN bookings b ON a.worker_id = b.worker_id AND a.id < b.id
        WHERE a.status = 'confirmed' AND b.status = 'confirmed' AND a.slot_window && b.slot_window`,
    )).rows[0].n;
    console.log(`correctness: shifts over headcount ${over}, workers double-booked into overlapping shifts ${doubles}`);
    if (over || doubles) problems.push('spread: overbooking or overlap');
    if (Object.keys(spread.byCode).some((k) => k.startsWith('5'))) problems.push('spread: server errors');

    // 3. Feed: workers browsing shifts near them.
    const feed = await blast(Array.from({ length: FEED_REQUESTS }, (_, i) => post('/worker/shifts/search', workers[i % WORKERS]!.auth, { radiusKm: 25 })), CONCURRENCY);
    report(`3. ${FEED_REQUESTS} feed requests (shifts within 25 km)`, feed);
    if (Object.keys(feed.byCode).some((k) => k !== '200')) problems.push('feed: non-200 responses');

    // Money still adds up after all that.
    const ledger = (await ctx.db.query(`SELECT COALESCE(sum(amount_paise), 0)::bigint AS s FROM ledger_entries`)).rows[0].s;
    console.log(`\nledger balance across all accounts: ${ledger} (must be 0)`);
    if (Number(ledger) !== 0) problems.push('ledger does not balance');
  } finally {
    await closeApp(ctx);
  }
  console.log(problems.length ? `\nFAILED: ${problems.join('; ')}` : '\nPASSED: no overbooking, no double-booking, no server errors, ledger balanced.');
  process.exit(problems.length ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
