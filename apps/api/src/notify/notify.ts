import { decrypt, encrypt } from '@shiftkart/shared';
import type { Db, Queryable } from '../db';
import { withTx } from '../db';
import { render, TEMPLATES, type Template, type TemplateName } from './templates';
import type { MessageSender } from '../adapters/messaging';

export type NotifyKeys = { dataKey: string };

/**
 * Queues a message in the caller's transaction (outbox pattern): if the action rolls back, nothing
 * is sent; if it commits, the dispatcher sends it. `dedupeKey` makes repeated triggers send once.
 * Text is rendered now, in the recipient's language, and stored encrypted.
 */
export async function notify(
  tx: Queryable, keys: NotifyKeys,
  n: { userId?: string; toPhone?: string; lang?: string; template: TemplateName; vars?: Record<string, string | number>; dedupeKey?: string },
) {
  let lang = n.lang ?? 'en';
  if (n.userId && !n.lang) lang = (await tx.query('SELECT preferred_lang FROM users WHERE id = $1', [n.userId])).rows[0]?.preferred_lang ?? 'en';
  const body = render(n.template, lang, n.vars ?? {});
  await tx.query(
    `INSERT INTO notifications (user_id, to_phone_enc, template, lang, body_enc, critical, dedupe_key) VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [n.userId ?? null, n.toPhone ? encrypt(n.toPhone, keys.dataKey) : null, n.template, lang, encrypt(body, keys.dataKey), TEMPLATES[n.template].critical, n.dedupeKey ?? null],
  );
}

/** Business owners and managers. */
export async function notifyBusiness(tx: Queryable, keys: NotifyKeys, businessId: string, template: TemplateName, vars: Record<string, string | number>, dedupeKey: string) {
  const m = await tx.query(`SELECT user_id FROM business_members WHERE business_id = $1 AND role IN ('owner', 'manager') AND removed_at IS NULL`, [businessId]);
  for (const r of m.rows) await notify(tx, keys, { userId: r.user_id, template, vars, dedupeKey: `${dedupeKey}:${r.user_id}` });
}

const istHour = (d: Date) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false }).format(d));

/** Next 07:00 IST after `d`. */
function nextMorning(d: Date) {
  const ist = new Date(d.getTime() + 330 * 60_000);
  const day = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) + (ist.getUTCHours() >= 7 ? 86400_000 : 0);
  return new Date(day + (7 * 60 - 330) * 60_000);
}

/**
 * Sends due messages. WhatsApp only for people who opted in, and only for templates allowed there;
 * otherwise (or if WhatsApp fails) SMS. Non-critical messages wait out quiet hours (22:00–07:00 IST);
 * reminders respect the user's opt-out. Retries with backoff.
 */
export async function dispatchNotifications(db: Db, senders: { sms: MessageSender; whatsapp: MessageSender }, keys: NotifyKeys, now = new Date()): Promise<number> {
  const claimed = await withTx(db, async (tx) => (await tx.query(
    `UPDATE notifications SET status = 'sending', attempts = attempts + 1
      WHERE id IN (SELECT id FROM notifications WHERE status = 'queued' AND next_attempt_at <= $1 ORDER BY created_at LIMIT 50 FOR UPDATE SKIP LOCKED)
      RETURNING *`, [now],
  )).rows);
  let sent = 0;
  for (const n of claimed) {
    const tpl = TEMPLATES[n.template as TemplateName] as Template;
    const user = n.user_id ? (await db.query('SELECT phone_enc, status, whatsapp_opt_in_at, reminders_opt_out FROM users WHERE id = $1', [n.user_id])).rows[0] : null;
    const finish = (status: string, extra: Record<string, unknown> = {}) => db.query(
      `UPDATE notifications SET status = $2, channel = $3, provider = $4, provider_ref = $5, last_error = $6, sent_at = CASE WHEN $2 = 'sent' THEN now() END, next_attempt_at = COALESCE($7, next_attempt_at) WHERE id = $1`,
      [n.id, status, extra.channel ?? null, extra.provider ?? null, extra.ref ?? null, extra.error ?? null, extra.next ?? null],
    );
    if (user && (user.status === 'deleted' || (tpl.reminder && user.reminders_opt_out))) { await finish('skipped', { error: 'user preference or deleted' }); continue; }
    const h = istHour(now);
    if (!n.critical && (h >= 22 || h < 7)) {
      // Quiet hours: wait until morning (doesn't count as a failed attempt).
      await db.query(`UPDATE notifications SET status = 'queued', attempts = attempts - 1, next_attempt_at = $2 WHERE id = $1`, [n.id, nextMorning(now)]);
      continue;
    }
    const to = decrypt(user ? user.phone_enc : n.to_phone_enc, keys.dataKey);
    const body = decrypt(n.body_enc, keys.dataKey);

    let result = null as null | Awaited<ReturnType<MessageSender['send']>>;
    let used = senders.sms;
    if (tpl.whatsapp && user?.whatsapp_opt_in_at) {
      used = senders.whatsapp;
      result = await senders.whatsapp.send(to, body, { template: n.template });
      if (!result.ok) { used = senders.sms; result = null; } // fall back to SMS
    }
    result ??= await used.send(to, body, { template: n.template });
    if (result.ok) { await finish('sent', { channel: used.channel, provider: used.provider, ref: result.providerRef }); sent += 1; }
    else if (result.retryable && n.attempts < 5) await finish('queued', { channel: used.channel, provider: used.provider, error: result.error, next: new Date(now.getTime() + 2 ** n.attempts * 60_000) });
    else await finish('failed', { channel: used.channel, provider: used.provider, error: result.error });
  }
  return sent;
}
