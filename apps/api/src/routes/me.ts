import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { LANGS, decrypt, maskPhone } from '@shiftkart/shared';
import type { AppDeps } from '../app';
import { parse, uuidParam } from '../lib/validate';
import { notFound } from '../lib/errors';
import { userActor } from '../auth/guard';
import { deleteAccount, exportData, grantConsent, withdrawConsent } from '../privacy';
import { writeAudit } from '../audit';
import { withTx } from '../db';

const PatchMe = z.object({ preferredLang: z.enum(LANGS) }).strict();

export async function meRoutes(app: FastifyInstance, { db, config }: AppDeps) {
  app.get('/me', { config: { auth: { user: {} } } }, async (req) => {
    const a = userActor(req);
    const u = (await db.query('SELECT * FROM users WHERE id = $1', [a.userId])).rows[0];
    return {
      id: u.id, kind: u.kind, status: u.status, preferredLang: u.preferred_lang,
      phone: maskPhone(decrypt(u.phone_enc, config.dataKey)),
    };
  });

  // Strict schema: fields like kind or status can't be smuggled in (mass assignment).
  app.patch('/me', { config: { auth: { user: {} } } }, async (req) => {
    const a = userActor(req);
    const { preferredLang } = parse(PatchMe, req.body);
    await db.query('UPDATE users SET preferred_lang = $2 WHERE id = $1', [a.userId, preferredLang]);
    return { ok: true };
  });

  // WhatsApp needs an explicit opt-in; reminders can be turned off. Critical messages (OTP, pay, safety) always go.
  app.get('/me/notifications', { config: { auth: { user: {} } } }, async (req) => {
    const u = (await db.query('SELECT whatsapp_opt_in_at, reminders_opt_out FROM users WHERE id = $1', [userActor(req).userId])).rows[0];
    return { whatsappOptIn: Boolean(u.whatsapp_opt_in_at), remindersOptOut: u.reminders_opt_out };
  });
  app.put('/me/notifications', { config: { auth: { user: {} } } }, async (req) => {
    const body = parse(z.object({ whatsappOptIn: z.boolean(), remindersOptOut: z.boolean() }).strict(), req.body);
    await db.query(
      `UPDATE users SET whatsapp_opt_in_at = CASE WHEN $2 THEN COALESCE(whatsapp_opt_in_at, now()) END, reminders_opt_out = $3 WHERE id = $1`,
      [userActor(req).userId, body.whatsappOptIn, body.remindersOptOut],
    );
    return body;
  });

  app.get('/me/sessions', { config: { auth: { user: {} } } }, async (req) => {
    const a = userActor(req);
    const r = await db.query(
      `SELECT DISTINCT ON (s.family_id) s.family_id, s.created_at, d.platform, d.last_seen
         FROM sessions s LEFT JOIN devices d ON d.id = s.device_id
        WHERE s.user_id = $1 AND s.revoked_at IS NULL AND s.refresh_expires_at > now()
        ORDER BY s.family_id, s.created_at DESC`,
      [a.userId],
    );
    return r.rows.map((s) => ({ id: s.family_id, platform: s.platform, lastSeen: s.last_seen, current: s.family_id === a.familyId }));
  });

  app.delete('/me/sessions/:familyId', { config: { auth: { user: {} } } }, async (req) => {
    const a = userActor(req);
    const { familyId } = parse(uuidParam('familyId'), req.params);
    const r = await db.query(
      `UPDATE sessions SET revoked_at = now(), revoke_reason = 'user_signed_out_device'
        WHERE family_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
      [familyId, a.userId],
    );
    if (!r.rowCount) throw notFound();
    return { ok: true };
  });

  // DPDP data rights (SPEC §6.12).
  app.get('/legal/grievance', { config: { auth: { public: true } } }, async () => ({
    appointed: Boolean(config.grievance.name && config.grievance.email),
    name: config.grievance.name || null,
    email: config.grievance.email || null,
    note: config.grievance.name ? null : 'DRAFT: a grievance officer has not been appointed yet.',
  }));

  app.get('/me/export', { config: { auth: { user: {} } } }, async (req, reply) => {
    const a = userActor(req);
    const data = await exportData(db, a.userId, config.dataKey);
    await withTx(db, (tx) => writeAudit(tx, { actorType: 'user', actorId: a.userId, action: 'user.data_exported', targetType: 'user', targetId: a.userId, ip: req.ip }));
    reply.header('content-disposition', 'attachment; filename="shiftkart-my-data.json"').header('cache-control', 'no-store');
    return data;
  });

  app.get('/me/consents', { config: { auth: { user: {} } } }, async (req) => {
    const r = await db.query(
      `SELECT purpose, bool_or(withdrawn_at IS NULL) AS active FROM consents WHERE user_id = $1 GROUP BY purpose`, [userActor(req).userId],
    );
    return Object.fromEntries(r.rows.map((c) => [c.purpose, c.active]));
  });

  const Purpose = z.object({ purpose: z.enum(['location_at_shift', 'face_verification', 'notifications']) }).strict();
  app.post('/me/consents/:purpose/withdraw', { config: { auth: { user: {} } } }, async (req) => {
    const a = userActor(req);
    const { purpose } = parse(Purpose, req.params);
    const r = await withdrawConsent(db, a.userId, purpose);
    await withTx(db, (tx) => writeAudit(tx, { actorType: 'user', actorId: a.userId, action: 'consent.withdrawn', targetType: 'user', targetId: a.userId, after: { purpose }, ip: req.ip }));
    return r;
  });
  app.post('/me/consents/:purpose/grant', { config: { auth: { user: {} } } }, async (req) => {
    const a = userActor(req);
    const { purpose } = parse(Purpose, req.params);
    const u = (await db.query('SELECT preferred_lang FROM users WHERE id = $1', [a.userId])).rows[0];
    const r = await grantConsent(db, a.userId, purpose, u.preferred_lang);
    await withTx(db, (tx) => writeAudit(tx, { actorType: 'user', actorId: a.userId, action: 'consent.granted', targetType: 'user', targetId: a.userId, after: { purpose }, ip: req.ip }));
    return r;
  });

  // Needs a typed confirmation so a stray tap can't delete an account.
  const DeleteBody = z.object({ confirm: z.literal('DELETE') }).strict();
  app.post('/me/delete', { config: { auth: { user: {} } } }, async (req) => {
    const a = userActor(req);
    parse(DeleteBody, req.body);
    return deleteAccount(db, a.userId, config.dataKey, req.ip);
  });
}
