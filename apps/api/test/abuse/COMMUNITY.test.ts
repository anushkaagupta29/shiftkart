// PAY-08 ratings · MSG-02/03/04 chat · BIZ-02 money requests · BIZ-06 blocking · OFF-01 hiring ·
// disputes timeline · SAF-01/02 SOS and incidents · WRK-06 underage report · BIZ-05 mismatch ·
// MON-01 self-dealing · MON-02 velocity · INT-04 re-review sampling · INT-05 read volume.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, makeApp, resetData, signUp, staffWith, type Ctx } from '../helpers';
import { WHITEFIELD, istSlot, liveShift, onShift, runJobs, seedRates, startShiftAgo, verifiedBusiness, verifiedWorker, workedShift, type Biz } from '../fixtures';

let ctx: Ctx;
let b: Biz;
beforeAll(async () => { ctx = await makeApp(); await resetData(ctx.db); await seedRates(ctx); b = await verifiedBusiness(ctx); });
afterAll(async () => closeApp(ctx));

const flagsOf = async (subject: string) => (await ctx.db.query(`SELECT rule_code FROM fraud_flags WHERE subject_id = $1 AND status = 'open'`, [subject])).rows.map((r) => r.rule_code);
const setPolicy = (key: string, value: unknown) => ctx.db.query(`INSERT INTO policy_config (key, value, reason, effective_from) VALUES ($1, $2, 'test', now() - interval '1 second')`, [key, JSON.stringify(value)]);
const bizUrl = (path: string) => `/businesses/${b.businessId}${path}`;

describe('PAY-08 ratings', () => {
  it('are blind until both sides rate', async () => {
    const s = await workedShift(ctx, b);
    await ctx.app.inject({ method: 'POST', url: bizUrl(`/bookings/${s.bookingId}/rating`), headers: b.owner.auth, payload: { stars: 2, tags: ['late'] } });
    expect((await ctx.db.query('SELECT revealed_at FROM ratings WHERE booking_id = $1', [s.bookingId])).rows[0].revealed_at).toBeNull();
    const before = (await ctx.app.inject({ method: 'GET', url: '/worker/strikes', headers: s.worker.auth })).json().rating;
    expect(before).toEqual({ score: 4.5, count: 0 }); // can't see it yet
    const w = await ctx.app.inject({ method: 'POST', url: `/worker/bookings/${s.bookingId}/rating`, headers: s.worker.auth, payload: { stars: 5, tags: ['paid_fairly'] } });
    expect(w.json().revealed).toBe(true);
    expect((await ctx.app.inject({ method: 'GET', url: '/worker/strikes', headers: s.worker.auth })).json().rating.count).toBe(1);
  });

  it('once per side, only after the shift, and no links or payment details in comments', async () => {
    const s = await onShift(ctx, b);
    expect((await ctx.app.inject({ method: 'POST', url: `/worker/bookings/${s.bookingId}/rating`, headers: s.worker.auth, payload: { stars: 5 } })).statusCode).toBe(409);
    const done = await workedShift(ctx, b);
    expect((await ctx.app.inject({ method: 'POST', url: `/worker/bookings/${done.bookingId}/rating`, headers: done.worker.auth, payload: { stars: 4, comment: 'Pay me on gpay 500 rs' } })).statusCode).toBe(400);
    expect((await ctx.app.inject({ method: 'POST', url: `/worker/bookings/${done.bookingId}/rating`, headers: done.worker.auth, payload: { stars: 4 } })).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'POST', url: `/worker/bookings/${done.bookingId}/rating`, headers: done.worker.auth, payload: { stars: 1 } })).statusCode).toBe(409);
  });

  it('a business giving mostly 1–2★ ratings is flagged for review itself', async () => {
    await setPolicy('ratings.harsh_rater_min', 3);
    const hb = await verifiedBusiness(ctx);
    for (let i = 0; i < 3; i++) {
      const s = await workedShift(ctx, hb);
      await ctx.app.inject({ method: 'POST', url: `/businesses/${hb.businessId}/bookings/${s.bookingId}/rating`, headers: hb.owner.auth, payload: { stars: 1 } });
    }
    expect(await flagsOf(hb.businessId)).toContain('harsh_rater');
    await setPolicy('ratings.harsh_rater_min', 10);
  });
});

describe('chat (MSG-02/03/04, BIZ-01/02)', () => {
  it('payment requests from a business never reach the worker; the worker gets a warning; the business is flagged', async () => {
    const s = await onShift(ctx, b);
    const sent = await ctx.app.inject({ method: 'POST', url: bizUrl(`/bookings/${s.bookingId}/chat`), headers: b.owner.auth, payload: { text: 'Send 500 rs registration fee on gpay to confirm' } });
    expect(sent.json()).toMatchObject({ status: 'blocked', flags: expect.arrayContaining(['payment_request']) });
    const workerView = (await ctx.app.inject({ method: 'GET', url: `/worker/bookings/${s.bookingId}/chat`, headers: s.worker.auth })).json();
    expect(JSON.stringify(workerView.messages)).not.toContain('registration fee');
    expect(workerView.messages.at(-1)).toMatchObject({ from: 'system', body: expect.stringContaining('never asks workers to pay') });
    expect(await flagsOf(b.businessId)).toContain('chat_payment_request');
  });

  it('links and UPI IDs are blocked; phone numbers are masked; ID-document requests come with a warning', async () => {
    const s = await onShift(ctx, b);
    const send = (text: string) => ctx.app.inject({ method: 'POST', url: `/worker/bookings/${s.bookingId}/chat`, headers: s.worker.auth, payload: { text } });
    expect((await send('check http://bit.ly/x1')).json().status).toBe('blocked');
    expect((await send('my upi ravi@okaxis')).json().status).toBe('blocked');
    expect((await send('call 98765 43210')).json()).toMatchObject({ status: 'delivered', flags: ['contact_masked'] });
    await ctx.app.inject({ method: 'POST', url: bizUrl(`/bookings/${s.bookingId}/chat`), headers: b.owner.auth, payload: { text: 'Send aadhaar photo here' } });
    const view = (await ctx.app.inject({ method: 'GET', url: bizUrl(`/bookings/${s.bookingId}/chat`), headers: b.owner.auth })).json();
    expect(JSON.stringify(view)).not.toContain('98765');
    const wv = (await ctx.app.inject({ method: 'GET', url: `/worker/bookings/${s.bookingId}/chat`, headers: s.worker.auth })).json();
    expect(wv.messages.at(-1).body).toMatch(/never need to send ID documents/);
  });

  it('is limited to 20 messages a minute, and only between the booked worker and that business', async () => {
    const s = await onShift(ctx, b);
    const codes = [];
    for (let i = 0; i < 21; i++) codes.push((await ctx.app.inject({ method: 'POST', url: `/worker/bookings/${s.bookingId}/chat`, headers: s.worker.auth, payload: { text: `hello ${i}` } })).statusCode);
    expect(codes.at(-1)).toBe(429);
    const stranger = await verifiedWorker(ctx);
    expect((await ctx.app.inject({ method: 'GET', url: `/worker/bookings/${s.bookingId}/chat`, headers: stranger.auth })).statusCode).toBe(404);
    const other = await verifiedBusiness(ctx);
    expect((await ctx.app.inject({ method: 'GET', url: `/businesses/${other.businessId}/bookings/${s.bookingId}/chat`, headers: other.owner.auth })).statusCode).toBe(404);
  });

  it('reporting a message flags the sender; masked calls never reveal a real number', async () => {
    const s = await onShift(ctx, b);
    await ctx.app.inject({ method: 'POST', url: bizUrl(`/bookings/${s.bookingId}/chat`), headers: b.owner.auth, payload: { text: 'Come to my room after the shift' } });
    const msg = (await ctx.app.inject({ method: 'GET', url: `/worker/bookings/${s.bookingId}/chat`, headers: s.worker.auth })).json().messages.at(-1);
    await ctx.app.inject({ method: 'POST', url: `/worker/messages/${msg.id}/report`, headers: s.worker.auth, payload: { reason: 'Inappropriate' } });
    expect(await flagsOf(b.businessId)).toContain('chat_reported');
    const call = (await ctx.app.inject({ method: 'POST', url: `/worker/bookings/${s.bookingId}/call`, headers: s.worker.auth })).json();
    expect(call.virtualNumber).toMatch(/^\+91 80 4718/);
    expect(call.virtualNumber.replace(/\D/g, '')).not.toContain(s.worker.phone.slice(3));
  });

  it('BIZ-06: a worker can block a business: its shifts disappear and chat closes', async () => {
    const s = await onShift(ctx, b);
    const fresh = await liveShift(ctx, b, { startsAt: istSlot(20, 9), endsAt: istSlot(20, 17) });
    await ctx.app.inject({ method: 'POST', url: `/worker/blocks/${b.businessId}`, headers: s.worker.auth, payload: { reason: 'Felt unsafe' } });
    const feed = (await ctx.app.inject({ method: 'POST', url: '/worker/shifts/search', headers: s.worker.auth, payload: {} })).json();
    expect(feed.items.find((x: { id: string }) => x.id === fresh.id)).toBeUndefined();
    expect((await ctx.app.inject({ method: 'POST', url: `/worker/bookings/${s.bookingId}/chat`, headers: s.worker.auth, payload: { text: 'hi' } })).statusCode).toBe(403);
    await ctx.app.inject({ method: 'DELETE', url: `/worker/blocks/${b.businessId}`, headers: s.worker.auth });
  });
});

describe('OFF-01 hiring full-time', () => {
  it('the worker can say no; contact details are exchanged only after the worker says yes and the business pays', async () => {
    const s = await workedShift(ctx, b);
    const offer = await ctx.app.inject({ method: 'POST', url: bizUrl('/hire-requests'), headers: b.owner.auth, payload: { bookingId: s.bookingId, roleTitle: 'Warehouse associate', monthlySalaryPaise: 2_000_000 } });
    expect(offer.json()).toMatchObject({ status: 'offered', feePaise: 500000 });
    expect((await ctx.app.inject({ method: 'POST', url: bizUrl(`/hire-requests/${offer.json().id}/pay`), headers: b.owner.auth })).statusCode).toBe(409);
    let list = (await ctx.app.inject({ method: 'GET', url: bizUrl('/hire-requests'), headers: b.owner.auth })).json();
    expect(list[0].contact).toBeNull();
    await ctx.app.inject({ method: 'POST', url: `/worker/hire-requests/${offer.json().id}/accept`, headers: s.worker.auth });
    const pay = (await ctx.app.inject({ method: 'POST', url: bizUrl(`/hire-requests/${offer.json().id}/pay`), headers: b.owner.auth })).json();
    await ctx.app.inject({ method: 'POST', url: `/mockpay/checkout/${pay.intentId}`, payload: { outcome: 'success' } });
    list = (await ctx.app.inject({ method: 'GET', url: bizUrl('/hire-requests'), headers: b.owner.auth })).json();
    expect(list[0]).toMatchObject({ status: 'paid', contact: s.worker.phone });
    const inv = (await ctx.app.inject({ method: 'GET', url: bizUrl('/invoices'), headers: b.owner.auth })).json();
    expect(inv.some((i: { taxablePaise: number }) => i.taxablePaise === 500000)).toBe(true);
    // Workers never pay, and there's no penalty route for leaving with a business.
    expect((await ctx.db.query(`SELECT count(*)::int AS n FROM payment_intents p JOIN hire_requests h ON h.id = p.hire_request_id WHERE h.worker_id = $1`, [s.worker.userId])).rows[0].n).toBe(1);
    expect((await ctx.db.query(`SELECT count(*)::int AS n FROM strikes WHERE worker_id = $1`, [s.worker.userId])).rows[0].n).toBe(0);
  });
});

describe('disputes: a timeline both sides can follow', () => {
  it('a timesheet dispute opens a case; the worker answers; the decision is explained to both', async () => {
    const s = await workedShift(ctx, b);
    await ctx.app.inject({ method: 'POST', url: bizUrl(`/timesheets/${s.timesheet.id}/dispute`), headers: b.owner.auth, payload: { minutes: 60, category: 'left_early', reason: 'Left an hour early without telling anyone' } });
    const cases = (await ctx.app.inject({ method: 'GET', url: '/worker/disputes', headers: s.worker.auth })).json();
    expect(cases[0]).toMatchObject({ kind: 'timesheet', status: 'open' });
    await ctx.app.inject({ method: 'POST', url: `/worker/disputes/${cases[0].id}/statements`, headers: s.worker.auth, payload: { body: 'I stayed until the end; the supervisor saw me at 5 pm.' } });
    const ops = await staffWith(ctx, ['ops_disputes']);
    await ctx.app.inject({ method: 'POST', url: `/admin/disputes/${cases[0].id}/action`, headers: ops.cookie, payload: { type: 'acknowledge' } });
    await ctx.app.inject({ method: 'POST', url: `/admin/disputes/${cases[0].id}/action`, headers: ops.cookie, payload: { type: 'note', body: 'Internal: check gate CCTV' } });
    await ctx.app.inject({ method: 'POST', url: `/admin/timesheets/${s.timesheet.id}/resolve`, headers: ops.cookie, payload: { awardMinutes: 60, reason: 'Check-out was at the gate at 17:01 with a matching selfie' } });
    const bizView = (await ctx.app.inject({ method: 'GET', url: bizUrl(`/disputes/${cases[0].id}`), headers: b.owner.auth })).json();
    expect(bizView.status).toBe('decided');
    expect(bizView.timeline.map((e: { type: string }) => e.type)).toEqual(['opened', 'statement', 'acknowledged', 'decision']);
    expect(JSON.stringify(bizView)).not.toContain('CCTV'); // internal notes stay internal
  });

  it('cases not acknowledged within 24 hours are flagged', async () => {
    const s = await workedShift(ctx, b);
    const c = await ctx.app.inject({ method: 'POST', url: '/worker/disputes', headers: s.worker.auth, payload: { bookingId: s.bookingId, kind: 'conduct', summary: 'Supervisor shouted at us all day' } });
    await ctx.db.query(`UPDATE dispute_cases SET ack_due_at = now() - interval '1 minute' WHERE id = $1`, [c.json().id]);
    await runJobs(ctx);
    expect(await flagsOf(`dispute:${c.json().id}`)).toContain('dispute_sla_breach');
  });
});

describe('safety (SAF-01, SAF-02, WRK-06, BIZ-05)', () => {
  it('SOS alerts the safety team and gives the trusted contact a live link that expires', async () => {
    const s = await onShift(ctx, b);
    await ctx.app.inject({ method: 'PUT', url: '/worker/trusted-contact', headers: s.worker.auth, payload: { name: 'Sister', phone: '9811100011' } });
    const sos = await ctx.app.inject({ method: 'POST', url: '/worker/sos', headers: s.worker.auth, payload: { bookingId: s.bookingId, ...WHITEFIELD, accuracyM: 20, shareWithContact: true } });
    expect(sos.json()).toMatchObject({ sharedWithContact: true });
    expect(await flagsOf(`sos:${sos.json().id}`)).toContain('sos_open');
    await ctx.db.query(`UPDATE notifications SET critical = true WHERE template = 'sos_trusted_contact'`); // already critical; keeps the test independent of the clock
    await runJobs(ctx);
    const sms = (await ctx.app.inject({ method: 'POST', url: '/dev/outbox', payload: { phone: '9811100011' } })).json()[0].body as string;
    const link = sms.match(/\/safety\/share\/[\w-]+/)![0];
    const page = await ctx.app.inject({ method: 'GET', url: link });
    expect(page.body).toContain('pressed SOS');
    expect(page.body).toContain('openstreetmap');
    const safety = await staffWith(ctx, ['ops_safety']);
    expect((await ctx.app.inject({ method: 'GET', url: '/admin/safety', headers: safety.cookie })).json().sos.length).toBeGreaterThan(0);
    await ctx.app.inject({ method: 'POST', url: `/admin/sos/${sos.json().id}/resolve`, headers: safety.cookie, payload: { note: 'Spoke to worker, safe now' } });
    expect((await ctx.app.inject({ method: 'GET', url: link })).body).toContain('expired');
  });

  it('anonymous reports store no reporter at all, and businesses have no way to read reports', async () => {
    const s = await onShift(ctx, b);
    const r = await ctx.app.inject({ method: 'POST', url: '/worker/incidents', headers: s.worker.auth, payload: { category: 'harassment', description: 'The supervisor made comments about my body', bookingId: s.bookingId, anonymous: true } });
    const row = (await ctx.db.query('SELECT * FROM incidents WHERE id = $1', [r.json().id])).rows[0];
    expect(row).toMatchObject({ reporter_type: 'anonymous', reporter_id: null, booking_id: null, business_id: b.businessId, severity: 'high' });
    expect(ctx.app.authTable.filter((x) => x.url.startsWith('/businesses') && /incident/.test(x.url) && x.method === 'GET')).toEqual([]);
  });

  it('a supervisor reporting a worker as possibly under 18 puts the account on review', async () => {
    const s = await onShift(ctx, b);
    await ctx.app.inject({ method: 'POST', url: bizUrl('/incidents'), headers: b.owner.auth, payload: { category: 'underage_worker', description: 'Looks about 15 years old', bookingId: s.bookingId } });
    expect(await flagsOf(s.worker.userId)).toContain('underage_report');
    expect((await ctx.app.inject({ method: 'GET', url: '/worker/me', headers: s.worker.auth })).json().verificationStatus).toBe('review');
  });

  it('three "work did not match the post" reports flag the business', async () => {
    const nb = await verifiedBusiness(ctx);
    for (let i = 0; i < 3; i++) {
      const s = await workedShift(ctx, nb);
      await ctx.app.inject({ method: 'POST', url: `/worker/bookings/${s.bookingId}/report-mismatch`, headers: s.worker.auth, payload: { details: 'Posted as billing, but we unloaded trucks all day' } });
    }
    expect(await flagsOf(nb.businessId)).toContain('work_mismatch_reports');
  });
});

describe('fraud rules', () => {
  it('MON-01: a worker on the same phone as a business member cannot take its shifts', async () => {
    const s = await liveShift(ctx, b, { startsAt: istSlot(22, 9), endsAt: istSlot(22, 17) });
    const w = await verifiedWorker(ctx);
    const ownerDevice = (await ctx.db.query('SELECT device_id_hash FROM devices WHERE user_id = $1 LIMIT 1', [b.owner.userId])).rows[0].device_id_hash;
    await ctx.db.query('INSERT INTO devices (user_id, device_id_hash) VALUES ($1, $2)', [w.userId, ownerDevice]);
    expect((await ctx.app.inject({ method: 'POST', url: `/worker/shifts/${s.id}/accept`, headers: w.auth })).statusCode).toBe(403);
    expect(await flagsOf(w.userId)).toContain('business_worker_device_link');
  });

  it('INT-04: approvals are randomly sampled for a second look', async () => {
    await setPolicy('review.random_sample_bp', 10_000);
    const nb = await verifiedBusiness(ctx);
    expect(await flagsOf(nb.businessId)).toContain('random_rereview');
    await setPolicy('review.random_sample_bp', 500);
  });

  it('INT-05: a staff member reading many personal records in an hour is flagged', async () => {
    await setPolicy('staff.read_alert_per_hour', 3);
    const support = await staffWith(ctx, ['ops_support']);
    const w = await signUp(ctx, 'worker');
    for (let i = 0; i < 4; i++) await ctx.app.inject({ method: 'GET', url: `/admin/users/${w.userId}`, headers: support.cookie });
    expect(await flagsOf(support.staffId)).toContain('staff_read_volume');
    await setPolicy('staff.read_alert_per_hour', 200);
  });

  it('MON-02: a new business paying mostly brand-new workers within a day is flagged at settlement', async () => {
    await setPolicy('velocity.new_business_workers', 1);
    const nb = await verifiedBusiness(ctx);
    await ctx.db.query(`UPDATE businesses SET verified_at = now() WHERE id = $1`, [nb.businessId]);
    const s = await workedShift(ctx, nb);
    await ctx.db.query(`UPDATE shifts SET published_at = now() WHERE id = $1`, [s.shift.id]);
    await ctx.app.inject({ method: 'POST', url: `/businesses/${nb.businessId}/timesheets/${s.timesheet.id}/approve`, headers: nb.owner.auth });
    await ctx.db.query(`UPDATE worker_profiles SET completed_shifts = 0 WHERE user_id = $1`, [s.worker.userId]);
    await startShiftAgo(ctx, s.shift.id, 8 * 60 + 200);
    await ctx.db.query(`UPDATE shifts SET published_at = ends_at - interval '10 hours' WHERE id = $1`, [s.shift.id]);
    await runJobs(ctx);
    expect(await flagsOf(nb.businessId)).toContain('velocity_new_business');
    await setPolicy('velocity.new_business_workers', 5);
    void randomUUID;
  });
});
