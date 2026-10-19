import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { encrypt, lookupHash, normalizeIndianPhone, type MemberRole } from '@shiftkart/shared';
import type { AppDeps } from '../app';
import type { Queryable } from '../db';
import { withTx } from '../db';
import { writeAudit } from '../audit';
import { parse } from '../lib/validate';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { userActor } from '../auth/guard';

const CreateBusiness = z.object({
  legalName: z.string().trim().min(2).max(200),
  tradeName: z.string().trim().min(2).max(200).optional(),
}).strict();
const AddMember = z.object({ phone: z.string().max(20), role: z.enum(['manager', 'supervisor']) }).strict();
const BizParams = z.object({ businessId: z.string().uuid() }).strict();
const MemberParams = z.object({ businessId: z.string().uuid(), memberId: z.string().uuid() }).strict();

/**
 * Membership is checked against the database on every request (not cached in the token),
 * so removing someone takes effect immediately (ACC-04). Non-members get 404, not 403,
 * so business IDs can't be probed (MSG-01).
 */
export async function requireMember(db: Queryable, businessId: string, userId: string, roles?: MemberRole[]) {
  const r = await db.query(
    'SELECT * FROM business_members WHERE business_id = $1 AND user_id = $2 AND removed_at IS NULL',
    [businessId, userId],
  );
  const m = r.rows[0];
  if (!m) throw notFound();
  if (roles && !roles.includes(m.role)) throw forbidden();
  return m as { id: string; role: MemberRole; business_id: string };
}

const bizAuth = { auth: { user: { kinds: ['business' as const] } } };

export async function businessRoutes(app: FastifyInstance, { db, config }: AppDeps) {
  app.post('/businesses', { config: bizAuth }, async (req, reply) => {
    const a = userActor(req);
    const body = parse(CreateBusiness, req.body);
    const biz = await withTx(db, async (tx) => {
      const b = (await tx.query(
        'INSERT INTO businesses (legal_name, trade_name, created_by) VALUES ($1, $2, $3) RETURNING *',
        [body.legalName, body.tradeName ?? null, a.userId],
      )).rows[0];
      await tx.query(`INSERT INTO business_members (business_id, user_id, role) VALUES ($1, $2, 'owner')`, [b.id, a.userId]);
      await writeAudit(tx, { actorType: 'user', actorId: a.userId, action: 'business.create', targetType: 'business', targetId: b.id, after: { legalName: b.legal_name }, ip: req.ip });
      return b;
    });
    reply.code(201);
    return { id: biz.id, legalName: biz.legal_name, tradeName: biz.trade_name, verificationStatus: biz.verification_status };
  });

  app.get('/businesses', { config: bizAuth }, async (req) => {
    const a = userActor(req);
    const r = await db.query(
      `SELECT b.id, b.legal_name, b.trade_name, b.verification_status, m.role
         FROM business_members m JOIN businesses b ON b.id = m.business_id
        WHERE m.user_id = $1 AND m.removed_at IS NULL ORDER BY b.created_at`,
      [a.userId],
    );
    return r.rows.map((b) => ({ id: b.id, legalName: b.legal_name, tradeName: b.trade_name, verificationStatus: b.verification_status, myRole: b.role }));
  });

  app.get('/businesses/:businessId', { config: bizAuth }, async (req) => {
    const a = userActor(req);
    const { businessId } = parse(BizParams, req.params);
    const m = await requireMember(db, businessId, a.userId);
    const b = (await db.query('SELECT * FROM businesses WHERE id = $1', [businessId])).rows[0];
    return { id: b.id, legalName: b.legal_name, tradeName: b.trade_name, verificationStatus: b.verification_status, myRole: m.role };
  });

  app.get('/businesses/:businessId/members', { config: bizAuth }, async (req) => {
    const a = userActor(req);
    const { businessId } = parse(BizParams, req.params);
    await requireMember(db, businessId, a.userId);
    const r = await db.query(
      `SELECT m.id, m.role, m.created_at, u.phone_last4 FROM business_members m JOIN users u ON u.id = m.user_id
        WHERE m.business_id = $1 AND m.removed_at IS NULL ORDER BY m.created_at`,
      [businessId],
    );
    return r.rows.map((m) => ({ id: m.id, role: m.role, phone: `+91 ******${m.phone_last4}`, addedAt: m.created_at }));
  });

  app.post('/businesses/:businessId/members', { config: bizAuth }, async (req, reply) => {
    const a = userActor(req);
    const { businessId } = parse(BizParams, req.params);
    const body = parse(AddMember, req.body);
    const phone = normalizeIndianPhone(body.phone);
    if (!phone) throw badRequest('invalid_phone', 'Enter a valid Indian mobile number (+91).');
    const member = await withTx(db, async (tx) => {
      await requireMember(tx, businessId, a.userId, ['owner']);
      const hash = lookupHash(phone, config.hashKey);
      let user = (await tx.query('SELECT id, kind FROM users WHERE phone_hash = $1', [hash])).rows[0];
      // Worker accounts can't be business members: keeps the two sides separate (MON-01).
      if (user && user.kind !== 'business') throw conflict('wrong_account_type', 'This number is registered as a worker.');
      if (!user) {
        user = (await tx.query(
          `INSERT INTO users (phone_enc, phone_hash, phone_last4, kind) VALUES ($1, $2, $3, 'business') RETURNING id`,
          [encrypt(phone, config.dataKey), hash, phone.slice(-4)],
        )).rows[0];
      }
      const m = (await tx.query(
        `INSERT INTO business_members (business_id, user_id, role, added_by) VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING RETURNING id, role`,
        [businessId, user.id, body.role, a.userId],
      )).rows[0];
      if (!m) throw conflict('already_member', 'This person is already a member.');
      await writeAudit(tx, { actorType: 'user', actorId: a.userId, action: 'business.member_add', targetType: 'business', targetId: businessId, after: { memberId: m.id, role: m.role }, ip: req.ip });
      return m;
    });
    reply.code(201);
    return { id: member.id, role: member.role, phone: `+91 ******${phone.slice(-4)}` };
  });

  app.delete('/businesses/:businessId/members/:memberId', { config: bizAuth }, async (req) => {
    const a = userActor(req);
    const { businessId, memberId } = parse(MemberParams, req.params);
    await withTx(db, async (tx) => {
      const me = await requireMember(tx, businessId, a.userId, ['owner']);
      if (me.id === memberId) throw badRequest('cannot_remove_self', 'The owner cannot remove themselves.');
      const r = await tx.query(
        `UPDATE business_members SET removed_at = now() WHERE id = $1 AND business_id = $2 AND removed_at IS NULL RETURNING role`,
        [memberId, businessId],
      );
      if (!r.rowCount) throw notFound();
      await writeAudit(tx, { actorType: 'user', actorId: a.userId, action: 'business.member_remove', targetType: 'business', targetId: businessId, before: { memberId, role: r.rows[0].role }, ip: req.ip });
    });
    return { ok: true };
  });
}
