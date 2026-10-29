import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import { STAFF_ROLES, decrypt, encrypt, hashPassword, lookupHash, newTotpSecret, normalizeIndianPhone, randomToken, verifyPassword, type StaffRole } from '@shiftkart/shared';
import type { AppDeps } from '../app';
import { withTx } from '../db';
import { writeAudit, verifyAuditChain } from '../audit';
import { pagination, parse, reasonField, uuidParam } from '../lib/validate';
import { HttpError, badRequest, conflict, forbidden, notFound } from '../lib/errors';
import { STAFF_COOKIE, staffActor } from '../auth/guard';
import { STAFF_SESSION_HOURS, staffLogin } from '../auth/staff';
import { revokeAllForUser } from '../auth/sessions';
import { recordStaffRead } from '../fraud-rules';
import { issueRemovalNotice, noticeRow, pendingNotice, withdrawRemovalNotice } from '../removal';

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
const UserStatus = z.object({ status: z.enum(['active', 'limited', 'suspended']), reason: reasonField, interimHold: z.boolean().optional() }).strict();
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
    const m = (await db.query('SELECT password_must_change FROM staff_users WHERE id = $1', [s.staffId])).rows[0];
    return { id: s.staffId, email: s.email, name: s.name, roles: s.roles, mustChangePassword: m.password_must_change };
  });

  app.post('/admin/me/password', { config: { auth: { staff: 'any' } } }, async (req) => {
    const s = staffActor(req);
    const body = parse(z.object({
      current: z.string().min(1).max(200),
      next: z.string().min(12, 'Use at least 12 characters').max(200).refine((p) => /[a-zA-Z]/.test(p) && /\d/.test(p), 'Use letters and numbers'),
    }).strict(), req.body);
    const row = (await db.query('SELECT password_hash FROM staff_users WHERE id = $1', [s.staffId])).rows[0];
    if (!(await verifyPassword(body.current, row.password_hash))) throw new HttpError(400, 'wrong_password', 'Current password is wrong.');
    if (body.current === body.next) throw badRequest('same_password', 'Choose a new password.');
    await withTx(db, async (tx) => {
      await tx.query('UPDATE staff_users SET password_hash = $2, password_must_change = false WHERE id = $1', [s.staffId, await hashPassword(body.next)]);
      // Other sessions end; this one stays.
      await tx.query('UPDATE staff_sessions SET revoked_at = now() WHERE staff_id = $1 AND id <> $2 AND revoked_at IS NULL', [s.staffId, s.sessionId]);
      await writeAudit(tx, { actorType: 'staff', actorId: s.staffId, actorRoles: s.roles, action: 'staff.password_change', targetType: 'staff', targetId: s.staffId, ip: req.ip });
    });
    return { ok: true };
  });

  app.get('/admin/summary', { config: { auth: { staff: 'any' } } }, async () => {
    const r = await db.query(`
      SELECT (SELECT count(*) FROM users WHERE kind = 'worker') AS workers,
             (SELECT count(*) FROM users WHERE kind = 'business') AS business_users,
             (SELECT count(*) FROM businesses) AS businesses,
             (SELECT count(*) FROM businesses WHERE verification_status = 'pending') AS businesses_pending,
             (SELECT count(*) FROM users WHERE status = 'suspended') AS suspended_users,
             (SELECT count(*) FROM shifts WHERE status = 'pending_review') AS shifts_review,
             (SELECT count(*) FROM shifts WHERE status = 'live' AND starts_at > now()) AS shifts_live,
             (SELECT count(*) FROM fraud_flags WHERE status = 'open') AS open_flags,
             (SELECT count(*) FROM worker_profiles WHERE verification_status = 'verified') AS verified_workers,
             (SELECT count(*) FROM sites WHERE status = 'pending_verify' AND business_id IN (SELECT id FROM businesses WHERE verification_status = 'verified')) AS sites_review,
             (SELECT count(*) FROM payouts WHERE status NOT IN ('paid', 'rejected', 'pending_approval', 'reversed') AND approved_at < now() - interval '24 hours') AS payouts_overdue,
             (SELECT count(*) FROM payouts WHERE status IN ('held', 'failed')) AS payouts_held,
             (SELECT count(*) FROM timesheets WHERE status IN ('disputed', 'partially_disputed')) AS disputes_open,
             (SELECT count(*) FROM reconciliation_runs WHERE status = 'mismatch' AND created_at > now() - interval '7 days') AS recon_mismatch,
             (SELECT count(*) FROM sos_events WHERE status <> 'resolved') AS sos_open,
             (SELECT count(*) FROM incidents WHERE status <> 'closed') AS incidents_open,
             (SELECT count(*) FROM strikes WHERE status = 'appealed') AS appeals_open,
             (SELECT count(*) FROM dispute_cases WHERE status IN ('open', 'under_review') AND decide_due_at < now()) AS cases_overdue`);
    const c = r.rows[0];
    return {
      workers: c.workers, verifiedWorkers: c.verified_workers, businessUsers: c.business_users, businesses: c.businesses,
      businessesPendingVerification: c.businesses_pending, suspendedUsers: c.suspended_users,
      shiftsPendingReview: c.shifts_review, liveShifts: c.shifts_live, openFraudFlags: c.open_flags, sitesPendingReview: c.sites_review,
      payoutsOverdue: c.payouts_overdue, payoutsHeld: c.payouts_held, disputesOpen: c.disputes_open, reconciliationMismatches: c.recon_mismatch,
      sosOpen: c.sos_open, incidentsOpen: c.incidents_open, appealsOpen: c.appeals_open, casesOverdue: c.cases_overdue,
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
    await recordStaffRead(db, staffActor(req).staffId, `user:${userId}`);
    const memberships = await db.query(
      `SELECT b.id, b.legal_name, m.role FROM business_members m JOIN businesses b ON b.id = m.business_id
        WHERE m.user_id = $1 AND m.removed_at IS NULL`, [userId]);
    const sessions = await db.query(
      `SELECT count(DISTINCT family_id) AS n FROM sessions WHERE user_id = $1 AND revoked_at IS NULL AND refresh_expires_at > now()`, [userId]);
    const s = staffActor(req);
    const w = (await db.query(
      `SELECT first_name, verification_status, kyc_status, dob_year, face_enrolled_at, completed_shifts, reliability_score, skills, languages
         FROM worker_profiles WHERE user_id = $1`, [userId])).rows[0];
    // INT-02: only finance sees payout details, and even then only the masked display form.
    const payout = s.roles.includes('finance')
      ? (await db.query(`SELECT type, display, status, name_match_score FROM payout_methods WHERE worker_id = $1 AND status IN ('verified', 'review')`, [userId])).rows[0]
      : undefined;
    const flags = await db.query(`SELECT id, rule_code, status, created_at FROM fraud_flags WHERE subject_type = 'worker' AND subject_id = $1 ORDER BY created_at DESC LIMIT 20`, [userId]);
    return {
      ...userRow(u),
      activeSessions: sessions.rows[0].n,
      businesses: memberships.rows.map((m) => ({ id: m.id, legalName: m.legal_name, role: m.role })),
      worker: w ? {
        firstName: w.first_name, verificationStatus: w.verification_status, kycStatus: w.kyc_status, birthYear: w.dob_year,
        selfieDone: Boolean(w.face_enrolled_at), completedShifts: w.completed_shifts, reliability: w.reliability_score, skills: w.skills, languages: w.languages,
      } : null,
      ...(payout ? { payout: { type: payout.type, display: payout.display, status: payout.status, nameMatch: payout.name_match_score } } : {}),
      flags: flags.rows.map((f) => ({ id: f.id, rule: f.rule_code, status: f.status, at: f.created_at })),
      removalNotice: w ? (await pendingNotice(db, userId).then((n) => n && noticeRow(n))) : null,
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
    const { status, reason, interimHold } = parse(UserStatus, req.body);
    return withTx(db, async (tx) => {
      const before = (await tx.query('SELECT status, kind FROM users WHERE id = $1 FOR UPDATE', [userId])).rows[0];
      if (!before) throw notFound();
      if (before.status === 'deleted') throw conflict('user_deleted', 'Deleted accounts cannot be changed.');
      if (interimHold && !(before.kind === 'worker' && status === 'suspended')) throw badRequest('invalid', 'interimHold only applies when removing a worker.');
      // Workers are removed only after written notice (D-091): suspending one issues the notice instead.
      if (before.kind === 'worker' && status === 'suspended' && before.status !== 'suspended') {
        const n = await issueRemovalNotice(tx, { dataKey: config.dataKey }, s, userId, reason, Boolean(interimHold), req.ip);
        return { ok: true, notice: noticeRow(n) };
      }
      // Reactivating a worker ends any running notice.
      const running = before.kind === 'worker' && status === 'active' ? await pendingNotice(tx, userId) : null;
      if (running) await withdrawRemovalNotice(tx, { dataKey: config.dataKey }, s, running.id, reason, req.ip);
      await tx.query('UPDATE users SET status = $2 WHERE id = $1', [userId, status]);
      if (status === 'suspended') await revokeAllForUser(tx, userId, 'suspended');
      await writeAudit(tx, { actorType: 'staff', actorId: s.staffId, actorRoles: s.roles, action: 'user.status_change', targetType: 'user', targetId: userId, reason, before: { status: before.status }, after: { status }, ip: req.ip });
      return { ok: true };
    });
  });

  app.post('/admin/removal-notices/:noticeId/withdraw', { config: { auth: { staff: ADMIN_ACCESS.changeUserStatus } } }, async (req) => {
    const s = staffActor(req);
    const { noticeId } = parse(uuidParam('noticeId'), req.params);
    const { reason } = parse(Reason, req.body);
    return withTx(db, async (tx) => noticeRow(await withdrawRemovalNotice(tx, { dataKey: config.dataKey }, s, noticeId, reason, req.ip)));
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
        `INSERT INTO staff_users (email, name, password_hash, totp_secret_enc, roles, password_must_change) VALUES ($1, $2, $3, $4, $5, true)
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
