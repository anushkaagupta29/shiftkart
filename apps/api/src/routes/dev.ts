import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { lookupHash, normalizeIndianPhone } from '@shiftkart/shared';
import type { AppDeps } from '../app';
import { parse } from '../lib/validate';

const Search = z.object({ phone: z.string().max(20).optional() }).strict();

/** Dev-only: read the mock SMS outbox to get OTP codes. Never registered in production. */
export async function devRoutes(app: FastifyInstance, { db, config }: AppDeps) {
  app.post('/dev/outbox', { config: { auth: { public: true } } }, async (req) => {
    const { phone } = parse(Search, req.body);
    const n = phone ? normalizeIndianPhone(phone) : null;
    const r = await db.query(
      `SELECT channel, to_masked, body, created_at FROM dev_outbox
        WHERE ($1::text IS NULL OR to_hash = $1) ORDER BY created_at DESC LIMIT 20`,
      [n ? lookupHash(n, config.hashKey) : null],
    );
    return r.rows.map((m) => ({ channel: m.channel, to: m.to_masked, body: m.body, at: m.created_at }));
  });
}
