// Ratings, chat (with masked calling) and blocks.
import { randomInt } from 'node:crypto';
import { encrypt } from '@shiftkart/shared';
import type { Db, Queryable } from './db';
import { withTx } from './db';
import { writeAudit } from './audit';
import { raiseFlag } from './fraud';
import { getPolicies } from './policy';
import { badRequest, conflict, forbidden, notFound, tooMany } from './lib/errors';
import { filterMessage } from './domain/chat-filter';
import { weightedScore } from './domain/ratings';
import { harshRaterCheck } from './fraud-rules';

export type Party = { kind: 'worker'; userId: string } | { kind: 'business'; userId: string; businessId: string };

/** The booking, checked to belong to this party (worker = booker; business = the shift's business). */
async function bookingFor(db: Queryable, p: Party, bookingId: string) {
  const b = (await db.query(
    `SELECT b.*, s.business_id, s.ends_at AS s_end, s.title FROM bookings b JOIN shifts s ON s.id = b.shift_id WHERE b.id = $1`, [bookingId])).rows[0];
  if (!b) throw notFound();
  if (p.kind === 'worker' && b.worker_id !== p.userId) throw notFound();
  if (p.kind === 'business' && b.business_id !== p.businessId) throw notFound();
  return b;
}

// ------------------------------------------------------------------ ratings

/**
 * Ratings both ways after a shift. Blind: nobody sees the other side's rating until both have
 * rated or 72 h have passed, so a rating can't be traded or used as a threat (PAY-08). Ratings
 * have nothing to do with timesheet approval.
 */
export async function rate(db: Db, p: Party, bookingId: string, input: { stars: number; tags: string[]; comment: string }) {
  return withTx(db, async (tx) => {
    const b = await bookingFor(tx, p, bookingId);
    if (!['completed', 'turned_away'].includes(b.status)) throw conflict('not_rateable', 'You can rate once the shift is done.');
    const pol = await getPolicies(tx, ['ratings.window_days']);
    if (Date.now() - b.s_end.getTime() > pol['ratings.window_days'] * 86400_000) throw conflict('too_late', 'The rating window has closed.');
    const f = filterMessage(input.comment || 'ok');
    if (input.comment && f.action === 'block') throw badRequest('comment_blocked', 'Comments can\'t include links, payment details or abuse.');
    const comment = input.comment ? f.body : '';
    try {
      await tx.query(
        `INSERT INTO ratings (booking_id, rater_type, rater_id, ratee_type, ratee_id, stars, tags, comment) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [bookingId, p.kind, p.kind === 'worker' ? p.userId : p.businessId, p.kind === 'worker' ? 'business' : 'worker',
         p.kind === 'worker' ? b.business_id : b.worker_id, input.stars, input.tags, comment],
      );
    } catch (e) {
      if ((e as { code?: string }).code === '23505') throw conflict('already_rated', 'You already rated this shift.');
      throw e;
    }
    const both = await tx.query(`SELECT count(*)::int AS n FROM ratings WHERE booking_id = $1`, [bookingId]);
    if (both.rows[0].n === 2) await tx.query(`UPDATE ratings SET revealed_at = now() WHERE booking_id = $1 AND revealed_at IS NULL`, [bookingId]);
    if (p.kind === 'business') await harshRaterCheck(tx, p.businessId);
    return { ok: true, revealed: both.rows[0].n === 2 };
  });
}

export async function revealDueRatings(db: Db) {
  const pol = await getPolicies(db, ['ratings.reveal_after_hours']);
  const r = await db.query(
    `UPDATE ratings r SET revealed_at = now() FROM bookings b JOIN shifts s ON s.id = b.shift_id
      WHERE r.booking_id = b.id AND r.revealed_at IS NULL AND s.ends_at < now() - make_interval(hours => $1)`,
    [pol['ratings.reveal_after_hours']],
  );
  return r.rowCount ?? 0;
}

export async function workerRating(db: Queryable, workerId: string) {
  const pol = await getPolicies(db, ['ratings.prior_mean_x100', 'ratings.prior_weight']);
  const rows = (await db.query(
    `SELECT r.stars, r.created_at, st.mean, st.sd, st.n
       FROM ratings r
       JOIN LATERAL (SELECT avg(stars)::float AS mean, COALESCE(stddev_pop(stars), 0)::float AS sd, count(*)::int AS n
                       FROM ratings x WHERE x.rater_type = 'business' AND x.rater_id = r.rater_id) st ON true
      WHERE r.ratee_type = 'worker' AND r.ratee_id = $1 AND r.revealed_at IS NOT NULL ORDER BY r.created_at`,
    [workerId],
  )).rows;
  return weightedScore(rows.map((r, i) => ({ stars: r.stars, raterMean: r.mean, raterSd: r.sd, raterCount: r.n, first: i === 0 })), pol['ratings.prior_mean_x100'] / 100, pol['ratings.prior_weight']);
}

export async function businessRating(db: Queryable, businessId: string) {
  const r = (await db.query(
    `SELECT avg(stars)::float AS avg, count(*)::int AS n FROM ratings WHERE ratee_type = 'business' AND ratee_id = $1 AND revealed_at IS NOT NULL`, [businessId])).rows[0];
  // Shown to workers only once there are a few ratings, so one person can't define a business.
  return r.n >= 3 ? { score: Math.round(r.avg * 10) / 10, count: r.n } : { score: null, count: r.n };
}

// ------------------------------------------------------------------ chat

async function conversationFor(tx: Queryable, p: Party, bookingId: string) {
  const b = await bookingFor(tx, p, bookingId);
  const pol = await getPolicies(tx, ['chat.open_after_end_hours']);
  const closes = new Date(b.s_end.getTime() + pol['chat.open_after_end_hours'] * 3600_000);
  const c = (await tx.query(
    `INSERT INTO conversations (booking_id, business_id, worker_id, closes_at) VALUES ($1, $2, $3, $4)
     ON CONFLICT (booking_id) DO UPDATE SET booking_id = EXCLUDED.booking_id RETURNING *`,
    [bookingId, b.business_id, b.worker_id, closes],
  )).rows[0];
  const blocked = await tx.query('SELECT 1 FROM worker_blocks WHERE worker_id = $1 AND business_id = $2', [b.worker_id, b.business_id]);
  const open = c.closes_at > new Date() && !blocked.rowCount && ['confirmed', 'checked_in', 'completed', 'turned_away', 'cancelled_business'].includes(b.status);
  return { c, b, open, blocked: Boolean(blocked.rowCount) };
}

export async function listMessages(db: Db, p: Party, bookingId: string) {
  return withTx(db, async (tx) => {
    const { c, open, blocked } = await conversationFor(tx, p, bookingId);
    const r = await tx.query(`SELECT id, sender_type, body, flags, status, created_at FROM messages WHERE conversation_id = $1 ORDER BY created_at`, [c.id]);
    const me = p.kind;
    return {
      open, blocked, closesAt: c.closes_at,
      // Blocked messages are visible only to their sender (with the reason); the other side sees a warning card instead.
      messages: r.rows.filter((m) => m.status === 'delivered' || m.sender_type === me || m.sender_type === 'system')
        .map((m) => ({ id: m.id, from: m.sender_type === me ? 'me' : m.sender_type, body: m.body, flags: m.flags, status: m.status, at: m.created_at })),
    };
  });
}

const SYSTEM_TEXT: Record<string, string> = {
  payment_request: '⚠️ The other person tried to ask for money. ShiftKart never asks workers to pay anything. Do not pay. Report it if they insist.',
  upi_id: '⚠️ The other person tried to share a payment ID. All pay goes through ShiftKart. Never send money to get or keep a shift.',
  link: '⚠️ The other person tried to send a link. Links are blocked to protect you from scams.',
  otp_request: '⚠️ The other person asked for an OTP/code. Never share codes you receive. This can be used to take over your accounts.',
  document_request: 'ℹ️ ShiftKart has already verified identities. You never need to send ID documents or bank details in chat.',
};

/** Sends a message through the filter. Payment requests and scam links never reach the other side. */
export async function sendMessage(db: Db, p: Party, bookingId: string, text: string, dataKey: string) {
  return withTx(db, async (tx) => {
    const { c, open } = await conversationFor(tx, p, bookingId);
    if (!open) throw forbidden('This chat is closed.');
    const pol = await getPolicies(tx, ['chat.max_per_min']);
    const recent = (await tx.query(
      `SELECT count(*)::int AS n FROM messages WHERE conversation_id = $1 AND sender_type = $2 AND created_at > now() - interval '1 minute'`, [c.id, p.kind])).rows[0].n;
    if (recent >= pol['chat.max_per_min']) throw tooMany('chat_rate_limited', 'Too many messages. Wait a minute.', 60);
    const f = filterMessage(text);
    if (f.flags.includes('empty')) throw badRequest('empty', 'Message is empty.');
    const status = f.action === 'block' ? 'blocked' : 'delivered';
    const m = (await tx.query(
      `INSERT INTO messages (conversation_id, sender_type, sender_id, body, original_enc, flags, status) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [c.id, p.kind, p.userId, f.body, f.body !== text.trim() || status === 'blocked' ? encrypt(text, dataKey) : null, f.flags, status],
    )).rows[0];
    const warn = f.flags.find((x) => SYSTEM_TEXT[x]);
    if (warn) {
      await tx.query(`INSERT INTO messages (conversation_id, sender_type, body, flags, status) VALUES ($1, 'system', $2, $3, 'delivered')`, [c.id, SYSTEM_TEXT[warn], [warn]]);
    }
    // BIZ-02: a business asking a worker for money is a serious signal.
    if (p.kind === 'business' && (f.flags.includes('payment_request') || f.flags.includes('upi_id') || f.flags.includes('otp_request'))) {
      await raiseFlag(tx, 'business', p.businessId, 'chat_payment_request', { bookingId, flags: f.flags }, 85);
    }
    if (f.flags.includes('abuse')) await raiseFlag(tx, p.kind === 'business' ? 'business' : 'worker', p.kind === 'business' ? p.businessId : p.userId, 'chat_abuse', { bookingId }, 40);
    return {
      id: m.id as string, status, flags: f.flags,
      ...(status === 'blocked' ? { notice: f.flags.includes('abuse') ? 'Not sent: abusive language.' : 'Not sent: links, payment requests and OTP requests are not allowed in chat.' } : {}),
    };
  });
}

export async function reportMessage(db: Db, p: Party, messageId: string, reason: string) {
  return withTx(db, async (tx) => {
    const m = (await tx.query(
      `SELECT m.*, c.booking_id, c.business_id, c.worker_id FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.id = $1`, [messageId])).rows[0];
    if (!m) throw notFound();
    const mine = p.kind === 'worker' ? m.worker_id === p.userId : m.business_id === p.businessId;
    if (!mine || m.sender_type === p.kind) throw notFound();
    await tx.query(`UPDATE messages SET reported_at = now(), report_reason = $2 WHERE id = $1`, [messageId, reason]);
    const subject = m.sender_type === 'business' ? ['business', m.business_id] : ['worker', m.worker_id];
    await raiseFlag(tx, subject[0] as 'worker' | 'business', subject[1], 'chat_reported', { messageId, reason }, 50);
    return { ok: true };
  });
}

/**
 * Masked calling (mock of an Exotel-style bridge): both sides dial one virtual number with a PIN;
 * neither ever sees the other's real number (MSG-04).
 */
export async function startCall(db: Db, p: Party, bookingId: string) {
  return withTx(db, async (tx) => {
    const { c, open } = await conversationFor(tx, p, bookingId);
    if (!open) throw forbidden('Calling is closed for this shift.');
    const s = (await tx.query(
      `INSERT INTO call_sessions (conversation_id, requested_by, virtual_number, pin, expires_at) VALUES ($1, $2, $3, $4, now() + interval '30 minutes') RETURNING *`,
      [c.id, p.kind, `+91 80 4718 ${String(randomInt(0, 10000)).padStart(4, '0')}`, String(randomInt(0, 10000)).padStart(4, '0')],
    )).rows[0];
    await tx.query(`INSERT INTO messages (conversation_id, sender_type, body, flags, status) VALUES ($1, 'system', $2, '{call}', 'delivered')`,
      [c.id, `📞 Call bridge open for 30 minutes: dial ${s.virtual_number}, PIN ${s.pin}. Your real number stays hidden.`]);
    return { virtualNumber: s.virtual_number as string, pin: s.pin as string, expiresAt: s.expires_at as Date, mock: true };
  });
}

export async function blockBusiness(db: Db, workerId: string, businessId: string, reason: string | undefined) {
  await db.query(`INSERT INTO worker_blocks (worker_id, business_id, reason) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [workerId, businessId, reason ?? null]);
  return { blocked: true };
}

export async function unblockBusiness(db: Db, workerId: string, businessId: string) {
  await db.query(`DELETE FROM worker_blocks WHERE worker_id = $1 AND business_id = $2`, [workerId, businessId]);
  return { blocked: false };
}

