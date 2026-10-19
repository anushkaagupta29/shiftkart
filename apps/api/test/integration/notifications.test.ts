import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { decrypt } from '@shiftkart/shared';
import { closeApp, makeApp, resetData, type Ctx } from '../helpers';
import { liveShift, seedRates, startShiftAgo, verifiedBusiness, verifiedWorker, type Biz } from '../fixtures';
import { dispatchNotifications, notify } from '../../src/notify/notify';
import { queueReminders } from '../../src/notify/reminders';
import { GupshupWhatsApp, Msg91Sms, MockSender, type MessageSender } from '../../src/adapters/messaging';

let ctx: Ctx;
let b: Biz;
beforeAll(async () => { ctx = await makeApp(); await resetData(ctx.db); await seedRates(ctx); b = await verifiedBusiness(ctx); });
afterAll(async () => closeApp(ctx));

const keys = () => ({ dataKey: ctx.config.dataKey });
const senders = () => ({ sms: new MockSender('sms', ctx.db, ctx.config.hashKey), whatsapp: new MockSender('whatsapp', ctx.db, ctx.config.hashKey) });
const NOON_IST = new Date('2026-11-02T06:30:00Z');
const NIGHT_IST = new Date('2026-11-02T17:30:00Z'); // 23:00 IST
const row = async (dedupe: string) => (await ctx.db.query('SELECT * FROM notifications WHERE dedupe_key = $1', [dedupe])).rows[0];

describe('outbox', () => {
  it('nothing is sent if the action that queued it rolls back', async () => {
    const w = await verifiedWorker(ctx);
    const client = await ctx.db.connect();
    await client.query('BEGIN');
    await notify(client, keys(), { userId: w.userId, template: 'payout_held', dedupeKey: 'rollback-test' });
    await client.query('ROLLBACK');
    client.release();
    expect(await row('rollback-test')).toBeUndefined();
  });

  it('the same event queues once, in the user\'s language, stored encrypted', async () => {
    const w = await verifiedWorker(ctx); // fixtures sign up in Hindi
    for (let i = 0; i < 3; i++) await notify(ctx.db, keys(), { userId: w.userId, template: 'payout_sent', vars: { paise: 75000, to: 'ra****@okaxis' }, dedupeKey: `dup:${w.userId}` });
    const r = (await ctx.db.query('SELECT * FROM notifications WHERE dedupe_key = $1', [`dup:${w.userId}`])).rows;
    expect(r).toHaveLength(1);
    expect(r[0].lang).toBe('hi');
    expect(r[0].body_enc).not.toContain('750');
    expect(decrypt(r[0].body_enc, ctx.config.dataKey)).toContain('₹750 ra****@okaxis पर भेजे गए');
  });

  it('Kannada users get Kannada', async () => {
    const w = await verifiedWorker(ctx);
    await ctx.db.query(`UPDATE users SET preferred_lang = 'kn' WHERE id = $1`, [w.userId]);
    await notify(ctx.db, keys(), { userId: w.userId, template: 'payout_held', dedupeKey: `kn:${w.userId}` });
    expect(decrypt((await row(`kn:${w.userId}`)).body_enc, ctx.config.dataKey)).toMatch(/ನಿಮ್ಮ ಹಣ/);
  });
});

describe('dispatcher', () => {
  it('uses WhatsApp only after opt-in, and falls back to SMS if WhatsApp fails', async () => {
    const w = await verifiedWorker(ctx);
    await notify(ctx.db, keys(), { userId: w.userId, template: 'hire_offer', vars: { role: 'Packer' }, dedupeKey: `wa1:${w.userId}` });
    await dispatchNotifications(ctx.db, senders(), keys(), NOON_IST);
    expect((await row(`wa1:${w.userId}`)).channel).toBe('sms');

    await ctx.app.inject({ method: 'PUT', url: '/me/notifications', headers: w.auth, payload: { whatsappOptIn: true, remindersOptOut: false } });
    await notify(ctx.db, keys(), { userId: w.userId, template: 'hire_offer', vars: { role: 'Packer' }, dedupeKey: `wa2:${w.userId}` });
    await dispatchNotifications(ctx.db, senders(), keys(), NOON_IST);
    expect((await row(`wa2:${w.userId}`)).channel).toBe('whatsapp');

    const broken: MessageSender = { channel: 'whatsapp', provider: 'broken', send: async () => ({ ok: false, retryable: true, error: 'down' }) };
    await notify(ctx.db, keys(), { userId: w.userId, template: 'hire_offer', vars: { role: 'Packer' }, dedupeKey: `wa3:${w.userId}` });
    await dispatchNotifications(ctx.db, { ...senders(), whatsapp: broken }, keys(), NOON_IST);
    expect(await row(`wa3:${w.userId}`)).toMatchObject({ channel: 'sms', status: 'sent' });
  });

  it('quiet hours delay non-critical messages to 07:00 IST; critical ones go now', async () => {
    const w = await verifiedWorker(ctx);
    await notify(ctx.db, keys(), { userId: w.userId, template: 'payout_sent', vars: { paise: 100, to: 'x' }, dedupeKey: `q1:${w.userId}` });
    await notify(ctx.db, keys(), { userId: w.userId, template: 'payout_held', dedupeKey: `q2:${w.userId}` });
    await dispatchNotifications(ctx.db, senders(), keys(), NIGHT_IST);
    const quiet = await row(`q1:${w.userId}`);
    expect(quiet.status).toBe('queued');
    expect(quiet.next_attempt_at.toISOString()).toBe('2026-11-03T01:30:00.000Z'); // 07:00 IST
    expect((await row(`q2:${w.userId}`)).status).toBe('sent');
  });

  it('reminders respect the opt-out; critical messages still go', async () => {
    const w = await verifiedWorker(ctx);
    await ctx.app.inject({ method: 'PUT', url: '/me/notifications', headers: w.auth, payload: { whatsappOptIn: false, remindersOptOut: true } });
    await notify(ctx.db, keys(), { userId: w.userId, template: 'shift_reminder_24h', vars: { title: 't', time: '9', site: 's' }, dedupeKey: `r:${w.userId}` });
    await notify(ctx.db, keys(), { userId: w.userId, template: 'waitlist_offer', vars: { title: 't', minutes: 5 }, dedupeKey: `c:${w.userId}` });
    await dispatchNotifications(ctx.db, senders(), keys(), NOON_IST);
    expect((await row(`r:${w.userId}`)).status).toBe('skipped');
    expect((await row(`c:${w.userId}`)).status).toBe('sent');
  });
});

describe('reminders and "I\'m coming"', () => {
  it('24 h and 3 h reminders go once each; unanswered workers at 2 h alert the business', async () => {
    const s = await liveShift(ctx, b);
    const w = await verifiedWorker(ctx);
    const bk = (await ctx.app.inject({ method: 'POST', url: `/worker/shifts/${s.id}/accept`, headers: w.auth })).json();
    await startShiftAgo(ctx, s.id, -20 * 60);
    await queueReminders(ctx.db, ctx.config.dataKey);
    await queueReminders(ctx.db, ctx.config.dataKey);
    expect((await ctx.db.query(`SELECT count(*)::int AS n FROM notifications WHERE dedupe_key = $1`, [`rem24:${bk.bookingId}`])).rows[0].n).toBe(1);
    await startShiftAgo(ctx, s.id, -150);
    await queueReminders(ctx.db, ctx.config.dataKey);
    expect(await row(`rem3:${bk.bookingId}`)).toBeDefined();
    await startShiftAgo(ctx, s.id, -60);
    await queueReminders(ctx.db, ctx.config.dataKey);
    expect((await ctx.db.query(`SELECT count(*)::int AS n FROM notifications WHERE dedupe_key LIKE $1`, [`unconf:${s.id}:%`])).rows[0].n).toBeGreaterThan(0);
  });

  it('answering "I\'m coming" is recorded; "I can\'t come" points to the cancel flow', async () => {
    const s = await liveShift(ctx, b);
    const w = await verifiedWorker(ctx);
    const bk = (await ctx.app.inject({ method: 'POST', url: `/worker/shifts/${s.id}/accept`, headers: w.auth })).json();
    expect((await ctx.app.inject({ method: 'POST', url: `/worker/bookings/${bk.bookingId}/intent`, headers: w.auth, payload: { coming: true } })).json()).toEqual({ coming: true, next: null });
    expect((await ctx.db.query('SELECT confirmed_attendance FROM bookings WHERE id = $1', [bk.bookingId])).rows[0].confirmed_attendance).toBe(true);
    expect((await ctx.app.inject({ method: 'POST', url: `/worker/bookings/${bk.bookingId}/intent`, headers: w.auth, payload: { coming: false } })).json().next).toBe('cancel');
  });
});

describe('real providers stay off', () => {
  it('MSG91 and Gupshup refuse to start unless real messages are explicitly allowed', () => {
    delete process.env.ALLOW_REAL_MESSAGES;
    expect(() => new Msg91Sms('key')).toThrow(/ALLOW_REAL_MESSAGES/);
    expect(() => new GupshupWhatsApp('key', 'src', 'app')).toThrow(/ALLOW_REAL_MESSAGES/);
  });

  it('the MSG91 adapter builds the documented request (checked against a fake, no network)', async () => {
    process.env.ALLOW_REAL_MESSAGES = 'true';
    process.env.MSG91_FLOW_PAYOUT_SENT = 'flow123';
    const fake = vi.fn(async () => new Response(JSON.stringify({ type: 'success', request_id: 'r1' }), { status: 200 }));
    try {
      const r = await new Msg91Sms('secret', fake as unknown as typeof fetch).send('+919876543210', 'hello', { template: 'payout_sent' });
      expect(r).toEqual({ ok: true, providerRef: 'r1' });
      const [url, init] = fake.mock.calls[0] as unknown as [string, RequestInit];
      expect(url).toBe('https://control.msg91.com/api/v5/flow/');
      expect(JSON.parse(String(init.body))).toMatchObject({ template_id: 'flow123', recipients: [{ mobiles: '919876543210' }] });
      expect((await new Msg91Sms('secret', fake as unknown as typeof fetch).send('+919876543210', 'x', { template: 'no_such' })).ok).toBe(false);
    } finally {
      delete process.env.ALLOW_REAL_MESSAGES;
      delete process.env.MSG91_FLOW_PAYOUT_SENT;
    }
  });
});
