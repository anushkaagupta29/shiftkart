import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { LANGS, decrypt, maskPhone } from '@shiftkart/shared';
import type { AppDeps } from '../app';
import { parse, uuidParam } from '../lib/validate';
import { notFound } from '../lib/errors';
import { userActor } from '../auth/guard';

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
}
