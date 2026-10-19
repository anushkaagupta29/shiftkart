import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { STAFF_ROLES, decrypt, encrypt, hashPassword, lookupHash, newTotpSecret, normalizeIndianPhone, randomToken, type StaffRole } from '@shiftkart/shared';
import type { AppDeps } from '../app';
import { withTx } from '../db';
import { writeAudit, verifyAuditChain } from '../audit';
import { pagination, parse, reasonField, uuidParam } from '../lib/validate';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { STAFF_COOKIE, staffActor } from '../auth/guard';
import { STAFF_SESSION_HOURS, staffLogin } from '../auth/staff';
import { revokeAllForUser } from '../auth/sessions';

// Who can do what (docs/SPEC.md §4). Kept in one place so the RBAC tests can read it.
export const ADMIN_ACCESS = {
  viewUsers: ['ops_support', 'ops_verifier', 'ops_disputes', 'ops_safety', 'compliance'],
  revealPhone: ['ops_safety'],
  changeUserStatus: ['ops_safety', 'compliance'],
  viewAudit: ['compliance', 'super_admin'],
  manageStaff: ['super_admin'],
  viewPolicy: ['compliance', 'super_admin', 'finance'],
} satisfies Record<string, StaffRole[]>;

const Login = z.object({
  email: z.string().email().max(200),
  password: z.string().min(1).max(200),
  totp: z.string().regex(/^\d{6}$/, '2FA code is 6 digits'),
}).strict();
const UserList = pagination.extend({
  kind: z.enum(['worker', 'business']).optional(),
  status: z.enum(['active', 'limited', 'suspended', 'deleted']).optional(),
}).strict();
const PhoneSearch = z.object({ phone: z.string().max(20) }).strict();
const Reason = z.object({ reason: reasonField }).strict();
const UserStatus = z.object({ status: z.enum(['active', 'limited', 'suspended']), reason: reasonField }).strict();
const AuditList = pagination.extend({ action: z.string().max(100).optional(), targetId: z.string().max(100).optional() }).strict();
const CreateStaff = z.object({
  email: z.string().email().max(200),
  name: z.string().trim().min(2).max(100),
  roles: z.array(z.enum(STAFF_ROLES)).min(1).max(STAFF_ROLES.length),
  reason: reasonField,
}).strict();
const StaffRoles = z.object({ roles: z.array(z.enum(STAFF_ROLES)).min(1).max(STAFF_ROLES.length), reason: reasonField }).strict();

function userRow(u: Record<string, any>) {
  return {
    id: u.id, kind: u.kind, status: u.status, preferredLang: u.preferred_lang,
    phone: `+91 ******${u.phone_last4}`, createdAt: u.created_at, lastLoginAt: u.last_login_at,
  };
}

export async function adminRoutes(app: FastifyInstance, { db, config }: AppDeps) {
  app.post('/admin/auth/login', { config: { auth: { public: true } } }, async (req, reply) => {
    const body = parse(Login, req.body);
    const { token, staff } = await staffLogin(db, config.dataKey, body, req.ip);
    reply.setCookie(STAFF_COOKIE, token, {
      httpOnly: true, sameSite: 'strict', secure: config.env === 'production', path: '/',
      maxAge: STAFF_SESSION_HOURS * 3600,
    });
    return { staff };
  });

  app.post('/admin/auth/logout', { config: { auth: { staff: 'any' } } }, async (req, reply) => {
    const s = staffActor(req);
    await db.query('UPDATE staff_sessions SET revoked_at = now() WHERE id = $1', [s.sessionId]);
    reply.clearCookie(STAFF_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/admin/me', { config: { auth: { staff: 'any' } } }, async (req) => {
    const s = staffActor(req);
    return { id: s.staffId, email: s.email, name: s.name, roles: s.roles };
  });

  app.get('/admin/summary', { config: { auth: { staff: 'any' } } }, async () => {
    const r = await db.query(`
      SELECT (SELECT count(*) FROM users WHERE kind = 'worker') AS workers,
             (SELECT count(*) FROM users WHERE kind = 'business') AS business_users,
             (SELECT count(*) FROM businesses) AS businesses,
             (SELECT count(*) FROM businesses WHERE verification_status = 'pending') AS businesses_pending,
             (SELECT count(*) FROM users WHERE status = 'suspended') AS suspended_users`);
    const c = r.rows[0];
    return {
      workers: c.workers, businessUsers: c.business_users, businesses: c.businesses,
      businessesPendingVerification: c.businesses_pending, suspendedUsers: c.suspended_users,
    };
  });

  // --- Users (phones always masked; revealing is a separate, audited action) ---

  app.get('/admin/users', { config: { auth: { staff: ADMIN_ACCESS.viewUsers } } }, async (req) => {
    const q = parse(UserList, req.query);
    const r = await db.query(
      `SELECT *, count(*) OVER () AS total FROM users
        WHERE ($1::text IS NULL OR kind = $1) AND ($2::text IS NULL OR status = $2)
        ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
      [q.kind ?? null, q.status ?? null, q.pageSize, (q.page - 1) * q.pageSize],
    );
    return { total: r.rows[0]?.total ?? 0, page: q.page, pageSize: q.pageSize, items: r.rows.map(userRow) };
  });

  // POST so the phone number never appears in a URL or access log.
  app.post('/admin/users/search', { config: { auth: { staff: ADMIN_ACCESS.viewUsers } } }, async (req) => {
    const { phone } = parse(PhoneSearch, req.body);
    const n = normalizeIndianPhone(phone);
    if (!n) throw badRequest('invalid_phone', 'Enter a valid Indian mobile number.');
    const r = await db.query('SELECT * FROM users WHERE phone_hash = $1', [lookupHash(n, config.hashKey)]);
    return { items: r.rows.map(userRow) };
  });

  app.get('/admin/users/:userId', { config: { auth: { staff: ADMIN_ACCESS.viewUsers } } }, async (req) => {
    const { userId } = parse(uuidParam('userId'), req.params);
    const u = (await db.query('SELECT * FROM users WHERE id = $1', [userId])).rows[0];
    if (!u) throw notFound();
    const memberships = await db.query(
      `SELECT b.id, b.legal_name, m.role FROM business_members m JOIN businesses b ON b.id = m.business_id
        WHERE m.user_id = $1 AND m.removed_at IS NULL`, [userId]);
    const sessions = await db.query(
      `SELECT count(DISTINCT family_id) AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL AND refresh_expires_at > now()`, [userId]);
    return {
      ...userRow(u),
      activeSessions: sessions.rows[0].n,
      businesses: memberships.rows.map((m) => ({ id: m.id, legalName: m.legal_name, role: m.role })),
    };
  });

  app.post('/admin/users/:userId/reveal-phone', { config: { auth: { staff: ADMIN_ACCESS.revealPhone } } }, async (req) => {
    const s = staffActor(req);
    const { userId } = parse(uuidParam('userId'), req.params);
    const { reason } = parse(Reason, req.body);
    return withTx(db, async (tx) => {
      const u = (await tx.query('SELECT phone_enc FROM users WHERE id = $1', [userId])).rows[0];
      if (!u) throw notFound();
      await writeAudit(tx, { actorType: 'staff', actorId: s.staffId, actorRoles: s.roles, action: 'user.phone_revealed', targetType: 'user', targetId: userId, reason, ip: req.ip });
      return { phone: decrypt(u.phone_enc, config.dataKey) };
    });
  });

  app.post('/admin/users/:userId/status', { config: { auth: { staff: ADMIN_ACCESS.changeUserStatus } } }, async (req) => {
    const s = staffActor(req);
    const { userId } = parse(uuidParam('userId'), req.params);
    const { status, reason } = parse(UserStatus, req.body);
    await withTx(db, async (tx) => {
      const before = (await tx.query('SELECT status FROM users WHERE id = $1 FOR UPDATE', [userId])).rows[0];
      if (!before) throw notFound();
      if (before.status === 'deleted') throw conflict('user_deleted', 'Deleted accounts cannot be changed.');
      await tx.query('UPDATE users SET status = $2 WHERE id = $1', [userId, status]);
      if (status === 'suspended') await revokeAllForUser(tx, userId, 'suspended');
      await writeAudit(tx, { actorType: 'staff', actorId: s.staffId, actorRoles: s.roles, action: 'user.status_change', targetType: 'user', targetId: userId, reason, before: { status: before.status }, after: { status }, ip: req.ip });
    });
    return { ok: true };
  });

  // --- Audit log ---

  app.get('/admin/audit', { config: { auth: { staff: ADMIN_ACCESS.viewAudit } } }, async (req) => {
    const q = parse(AuditList, req.query);
    const r = await db.query(
      `SELECT a.*, su.email AS staff_email, count(*) OVER () AS total
         FROM audit_log a LEFT JOIN staff_users su ON a.actor_type = 'staff' AND su.id = a.actor_id
        WHERE ($1::text IS NULL OR a.action = $1) AND ($2::text IS NULL OR a.target_id = $2)
        ORDER BY a.seq DESC LIMIT $3 OFFSET $4`,
      [q.action ?? null, q.targetId ?? null, q.pageSize, (q.page - 1) * q.pageSize],
    );
    return {
      total: r.rows[0]?.total ?? 0, page: q.page, pageSize: q.pageSize,
      items: r.rows.map((a) => ({
        seq: a.seq, at: a.at, actorType: a.actor_type, actorId: a.actor_id, actorEmail: a.staff_email, actorRoles: a.actor_roles,
        action: a.action, targetType: a.target_type, targetId: a.target_id, reason: a.reason, before: a.before, after: a.after,
      })),
    };
  });

  app.get('/admin/audit/verify', { config: { auth: { staff: ADMIN_ACCESS.viewAudit } } }, async () => verifyAuditChain(db));

  // --- Staff management ---

  app.get('/admin/staff', { config: { auth: { staff: ADMIN_ACCESS.manageStaff } } }, async () => {
    const r = await db.query('SELECT id, email, name, roles, status, last_login_at FROM staff_users ORDER BY email');
    return r.rows.map((s) => ({ id: s.id, email: s.email, name: s.name, roles: s.roles, status: s.status, lastLoginAt: s.last_login_at }));
  });

  app.post('/admin/staff', { config: { auth: { staff: ADMIN_ACCESS.manageStaff } } }, async (req, reply) => {
    const s = staffActor(req);
    const body = parse(CreateStaff, req.body);
    // Shown once so the new staffer can log in and add the secret to an authenticator app.
    const tempPassword = randomToken('', 12);
    const totpSecret = newTotpSecret();
    const created = await withTx(db, async (tx) => {
      const r = await tx.query(
        `INSERT INTO staff_users (email, name, password_hash, totp_secret_enc, roles) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (email) DO NOTHING RETURNING id`,
        [body.email, body.name, await hashPassword(tempPassword), encrypt(totpSecret, config.dataKey), body.roles],
      );
      if (!r.rowCount) throw conflict('email_taken', 'A staff account with this email exists.');
      await writeAudit(tx, { actorType: 'staff', actorId: s.staffId, actorRoles: s.roles, action: 'staff.create', targetType: 'staff', targetId: r.rows[0].id, reason: body.reason, after: { email: body.email, roles: body.roles }, ip: req.ip });
      return r.rows[0];
    });
    reply.code(201);
    return { id: created.id, tempPassword, totpSecret };
  });

  app.post('/admin/staff/:staffId/roles', { config: { auth: { staff: ADMIN_ACCESS.manageStaff } } }, async (req) => {
    const s = staffActor(req);
    const { staffId } = parse(uuidParam('staffId'), req.params);
    const { roles, reason } = parse(StaffRoles, req.body);
    if (staffId === s.staffId) throw forbidden('You cannot change your own roles.');
    await withTx(db, async (tx) => {
      const before = (await tx.query('SELECT roles FROM staff_users WHERE id = $1 FOR UPDATE', [staffId])).rows[0];
      if (!before) throw notFound();
      await tx.query('UPDATE staff_users SET roles = $2 WHERE id = $1', [staffId, roles]);
      // Sessions are dropped so new permissions apply from the next login.
      await tx.query('UPDATE staff_sessions SET revoked_at = now() WHERE staff_id = $1 AND revoked_at IS NULL', [staffId]);
      await writeAudit(tx, { actorType: 'staff', actorId: s.staffId, actorRoles: s.roles, action: 'staff.roles_change', targetType: 'staff', targetId: staffId, reason, before: { roles: before.roles }, after: { roles }, ip: req.ip });
    });
    return { ok: true };
  });

  app.post('/admin/staff/:staffId/disable', { config: { auth: { staff: ADMIN_ACCESS.manageStaff } } }, async (req) => {
    const s = staffActor(req);
    const { staffId } = parse(uuidParam('staffId'), req.params);
    const { reason } = parse(Reason, req.body);
    if (staffId === s.staffId) throw forbidden('You cannot disable yourself.');
    await withTx(db, async (tx) => {
      const r = await tx.query(`UPDATE staff_users SET status = 'disabled' WHERE id = $1 AND status = 'active'`, [staffId]);
      if (!r.rowCount) throw notFound();
      await tx.query('UPDATE staff_sessions SET revoked_at = now() WHERE staff_id = $1 AND revoked_at IS NULL', [staffId]);
      await writeAudit(tx, { actorType: 'staff', actorId: s.staffId, actorRoles: s.roles, action: 'staff.disable', targetType: 'staff', targetId: staffId, reason, ip: req.ip });
    });
    return { ok: true };
  });

  // --- Policy (read-only in Phase 1; changes with maker-checker arrive in Phase 2) ---

  app.get('/admin/policy', { config: { auth: { staff: ADMIN_ACCESS.viewPolicy } } }, async () => {
    const r = await db.query(
      `SELECT DISTINCT ON (key, scope) key, scope, value, effective_from, reason FROM policy_config
        WHERE effective_from <= now() ORDER BY key, scope, effective_from DESC`);
    return r.rows.map((p) => ({ key: p.key, scope: p.scope, value: p.value, effectiveFrom: p.effective_from, reason: p.reason }));
  });

}
