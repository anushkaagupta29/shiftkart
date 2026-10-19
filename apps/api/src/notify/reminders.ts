import type { Db } from '../db';
import { notify, notifyBusiness } from './notify';

const istHM = (d: Date) => new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit' }).format(d);

/**
 * SPEC §6.4: reminders at T-24h and T-3h with "I'm coming / I can't come". If workers haven't
 * answered by T-2h, the business is told (and the waitlist is the standby). Nobody is cancelled
 * automatically for not answering.
 */
export async function queueReminders(db: Db, dataKey: string): Promise<number> {
  let n = 0;
  const r24 = await db.query(
    `SELECT b.id, b.worker_id, s.title, s.starts_at, si.name AS site FROM bookings b JOIN shifts s ON s.id = b.shift_id JOIN sites si ON si.id = s.site_id
      WHERE b.status = 'confirmed' AND s.status = 'live' AND s.starts_at > now() + interval '3 hours' AND s.starts_at <= now() + interval '24 hours'`);
  for (const b of r24.rows) {
    await notify(db, { dataKey }, { userId: b.worker_id, template: 'shift_reminder_24h', vars: { title: b.title, time: istHM(b.starts_at), site: b.site }, dedupeKey: `rem24:${b.id}` });
    n += 1;
  }
  const r3 = await db.query(
    `SELECT b.id, b.worker_id, s.title, s.starts_at, s.bring_items, si.name AS site FROM bookings b JOIN shifts s ON s.id = b.shift_id JOIN sites si ON si.id = s.site_id
      WHERE b.status = 'confirmed' AND s.status = 'live' AND s.starts_at > now() + interval '2 hours' AND s.starts_at <= now() + interval '3 hours'`);
  for (const b of r3.rows) {
    await notify(db, { dataKey }, { userId: b.worker_id, template: 'shift_reminder_3h', vars: { title: b.title, time: istHM(b.starts_at), site: b.site, bring: b.bring_items || 'ID card' }, dedupeKey: `rem3:${b.id}` });
    n += 1;
  }
  const unconfirmed = await db.query(
    `SELECT s.id, s.business_id, s.title, s.starts_at, count(*)::int AS c FROM bookings b JOIN shifts s ON s.id = b.shift_id
      WHERE b.status = 'confirmed' AND s.status = 'live' AND s.starts_at > now() AND s.starts_at <= now() + interval '2 hours'
        AND (b.confirmed_attendance IS NOT TRUE)
      GROUP BY s.id`);
  for (const s of unconfirmed.rows) {
    await notifyBusiness(db, { dataKey }, s.business_id, 'worker_not_confirmed', { count: s.c, title: s.title, time: istHM(s.starts_at) }, `unconf:${s.id}`);
  }
  return n;
}
