// Removing a worker needs written reasons and 14 days' notice (Karnataka gig workers act; LEGAL L-03, D-091).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, makeApp, resetData, signUp, staffWith, type Ctx } from '../helpers';
import { liveShift, runJobs, seedRates, verifiedBusiness, verifiedWorker, type Biz } from '../fixtures';

let ctx: Ctx;
let b: Biz;
beforeAll(async () => { ctx = await makeApp(); await resetData(ctx.db); await seedRates(ctx); b = await verifiedBusiness(ctx); });
afterAll(async () => closeApp(ctx));

const suspend = (cookie: Record<string, string>, userId: string, payload: Record<string, unknown> = {}) =>
  ctx.app.inject({ method: 'POST', url: `/admin/users/${userId}/status`, headers: cookie, payload: { status: 'suspended', reason: 'Repeated no-shows, see flags', ...payload } });
const statusOf = async (userId: string) => (await ctx.db.query('SELECT status FROM users WHERE id = $1', [userId])).rows[0].status;
/** Pretend the notice was issued `days` ago. */
const age = (noticeId: string, days: number) =>
  ctx.db.query(`UPDATE removal_notices SET issued_at = issued_at - make_interval(days => $2), effective_at = effective_at - make_interval(days => $2) WHERE id = $1`, [noticeId, days]);

describe('removing a worker', () => {
  it('suspending a worker issues a 14-day notice with reasons; they keep working until it falls due', async () => {
    const safety = await staffWith(ctx, ['ops_safety']);
    const w = await verifiedWorker(ctx);
    const r = await suspend(safety.cookie, w.userId);
    expect(r.statusCode).toBe(200);
    const { notice } = r.json();
    expect(notice).toMatchObject({ status: 'pending', noticeDays: 14, interimHold: false, reasons: 'Repeated no-shows, see flags' });
    expect(new Date(notice.effectiveAt).getTime() - new Date(notice.issuedAt).getTime()).toBe(14 * 86400_000);
    expect(await statusOf(w.userId)).toBe('active');

    // The worker is told in writing, by SMS, with the reasons and the date.
    const sms = (await ctx.db.query(`SELECT critical FROM notifications WHERE user_id = $1 AND template = 'removal_notice'`, [w.userId])).rows;
    expect(sms).toEqual([{ critical: true }]);

    // They can still sign in, take shifts, read the notice and reply.
    const s = await liveShift(ctx, b);
    expect((await ctx.app.inject({ method: 'POST', url: `/worker/shifts/${s.id}/accept`, headers: w.auth, payload: { nightConsent: true } })).statusCode).toBe(201);
    expect((await ctx.app.inject({ method: 'GET', url: '/worker/removal-notice', headers: w.auth })).json().notice).toMatchObject({ id: notice.id, reasons: 'Repeated no-shows, see flags' });
    const reply = await ctx.app.inject({ method: 'POST', url: `/worker/removal-notice/${notice.id}/respond`, headers: w.auth, payload: { response: 'I was in hospital on those days, I have the papers.' } });
    expect(reply.json()).toMatchObject({ workerResponse: 'I was in hospital on those days, I have the papers.' });

    // Staff see the reply on the worker's page.
    const detail = (await ctx.app.inject({ method: 'GET', url: `/admin/users/${w.userId}`, headers: safety.cookie })).json();
    expect(detail.removalNotice).toMatchObject({ id: notice.id, workerResponse: expect.stringContaining('hospital') });

    // A second notice can't stack on the first.
    expect((await suspend(safety.cookie, w.userId)).statusCode).toBe(409);
  });

  it('the job does nothing before day 14 and removes the worker once the notice has run', async () => {
    const safety = await staffWith(ctx, ['ops_safety']);
    const w = await verifiedWorker(ctx);
    const { notice } = (await suspend(safety.cookie, w.userId)).json();
    await age(notice.id, 13);
    await runJobs(ctx);
    expect(await statusOf(w.userId)).toBe('active');

    await age(notice.id, 1);
    expect((await runJobs(ctx)).workersRemoved).toBe(1);
    expect(await statusOf(w.userId)).toBe('suspended');
    expect((await ctx.app.inject({ method: 'GET', url: '/me', headers: w.auth })).statusCode).toBe(401);
    const row = (await ctx.db.query(`SELECT actor_type, reason FROM audit_log WHERE action = 'worker.removed' AND target_id = $1`, [w.userId])).rows[0];
    expect(row).toEqual({ actor_type: 'system', reason: 'Repeated no-shows, see flags' });
    // Running the job again changes nothing.
    expect((await runJobs(ctx)).workersRemoved).toBe(0);
  });

  it('withdrawing the notice (or reactivating) stops the removal and tells the worker', async () => {
    const compliance = await staffWith(ctx, ['compliance']);
    const w1 = await verifiedWorker(ctx);
    const n1 = (await suspend(compliance.cookie, w1.userId)).json().notice;
    const wd = await ctx.app.inject({ method: 'POST', url: `/admin/removal-notices/${n1.id}/withdraw`, headers: compliance.cookie, payload: { reason: 'Hospital papers checked' } });
    expect(wd.json()).toMatchObject({ status: 'withdrawn', closeReason: 'Hospital papers checked' });

    const w2 = await verifiedWorker(ctx);
    const n2 = (await suspend(compliance.cookie, w2.userId)).json().notice;
    await ctx.app.inject({ method: 'POST', url: `/admin/users/${w2.userId}/status`, headers: compliance.cookie, payload: { status: 'active', reason: 'Appeal accepted' } });

    await age(n1.id, 15); await age(n2.id, 15);
    await runJobs(ctx);
    expect(await statusOf(w1.userId)).toBe('active');
    expect(await statusOf(w2.userId)).toBe('active');
    const told = (await ctx.db.query(`SELECT count(*)::int AS n FROM notifications WHERE user_id = ANY($1) AND template = 'removal_withdrawn'`, [[w1.userId, w2.userId]])).rows[0].n;
    expect(told).toBe(2);
  });

  it('a safety hold stops new bookings during the notice, but the worker can still sign in and reply; only safety staff can impose it', async () => {
    const compliance = await staffWith(ctx, ['compliance']);
    const safety = await staffWith(ctx, ['ops_safety']);
    const w = await verifiedWorker(ctx);
    expect((await suspend(compliance.cookie, w.userId, { interimHold: true })).statusCode).toBe(403);
    const { notice } = (await suspend(safety.cookie, w.userId, { interimHold: true, reason: 'Harassment report from site supervisor' })).json();
    expect(notice).toMatchObject({ interimHold: true, noticeDays: 14 });
    const s = await liveShift(ctx, b);
    expect((await ctx.app.inject({ method: 'POST', url: `/worker/shifts/${s.id}/accept`, headers: w.auth, payload: { nightConsent: true } })).statusCode).toBe(403);
    expect((await ctx.app.inject({ method: 'GET', url: '/worker/removal-notice', headers: w.auth })).statusCode).toBe(200);
  });

  it('the notice can be lengthened by policy but never shortened below 14 days', async () => {
    const safety = await staffWith(ctx, ['ops_safety']);
    const setDays = (d: number, ago: string) => ctx.db.query(`INSERT INTO policy_config (key, scope, value, reason, effective_from) VALUES ('removal.notice_days', 'global', $1, 'test', now() - $2::interval)`, [String(d), ago]);
    await setDays(21, '2 seconds');
    expect((await suspend(safety.cookie, (await verifiedWorker(ctx)).userId)).json().notice.noticeDays).toBe(21);
    await setDays(3, '1 second');
    expect((await suspend(safety.cookie, (await verifiedWorker(ctx)).userId)).json().notice.noticeDays).toBe(14);
    await setDays(14, '0 seconds'); // policy_config is append-only: put the default back
  });

  it('businesses are not gig workers: suspending one is still immediate', async () => {
    const safety = await staffWith(ctx, ['ops_safety']);
    const owner = await signUp(ctx, 'business');
    expect((await suspend(safety.cookie, owner.userId)).json()).toEqual({ ok: true });
    expect(await statusOf(owner.userId)).toBe('suspended');
  });
});
