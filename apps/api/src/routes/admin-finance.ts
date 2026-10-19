import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app';
import { writeAudit } from '../audit';
import { withTx } from '../db';
import { pagination, parse, reasonField, uuidParam } from '../lib/validate';
import { conflict } from '../lib/errors';
import { staffActor } from '../auth/guard';
import { decideManualPayout, reconcile, requestManualPayout, resolveDispute } from '../money';
import { istDate } from '../time';

const finance = { auth: { staff: ['finance' as const] } };
const disputes = { auth: { staff: ['ops_disputes' as const] } };

export async function adminFinanceRoutes(app: FastifyInstance, { db }: AppDeps) {
  app.get('/admin/payouts', { config: { auth: { staff: ['finance', 'ops_support'] } } }, async (req) => {
    const q = parse(pagination.extend({ status: z.enum(['pending_approval', 'queued', 'processing', 'paid', 'failed', 'held', 'reversed', 'rejected']).optional() }).strict(), req.query);
    const r = await db.query(
      `SELECT p.*, w.first_name, m.display, rq.email AS requested_email, ap.email AS approved_email, count(*) OVER () AS total
         FROM payouts p JOIN worker_profiles w ON w.user_id = p.worker_id
         LEFT JOIN payout_methods m ON m.id = p.payout_method_id
         LEFT JOIN staff_users rq ON rq.id = p.requested_by LEFT JOIN staff_users ap ON ap.id = p.approved_by
        WHERE ($1::text IS NULL OR p.status = $1) ORDER BY p.created_at DESC LIMIT $2 OFFSET $3`,
      [q.status ?? null, q.pageSize, (q.page - 1) * q.pageSize],
    );
    const s = staffActor(req);
    const showDest = s.roles.includes('finance');
    return {
      total: r.rows[0]?.total ?? 0, page: q.page, pageSize: q.pageSize,
      items: r.rows.map((p) => ({
        id: p.id, workerId: p.worker_id, firstName: p.first_name, kind: p.kind, amountPaise: Number(p.amount_paise), status: p.status,
        heldReason: p.held_reason, attempts: p.attempt_count, lastError: p.last_error, paidTo: showDest ? p.display : undefined,
        requestedBy: p.requested_email, approvedBy: p.approved_email, reason: p.reason, approvedAt: p.approved_at, paidAt: p.paid_at, createdAt: p.created_at,
        // Payout delay (dashboard metric): approved but still unpaid after the SLA.
        overdue: !p.paid_at && p.status !== 'pending_approval' && p.status !== 'rejected' && Date.now() - new Date(p.approved_at).getTime() > 24 * 3600_000,
      })),
    };
  });

  app.post('/admin/payouts/:payoutId/retry', { config: finance }, async (req) => {
    const s = staffActor(req);
    const { payoutId } = parse(uuidParam('payoutId'), req.params);
    const { reason } = parse(z.object({ reason: reasonField }).strict(), req.body);
    return withTx(db, async (tx) => {
      const r = await tx.query(
        `UPDATE payouts SET status = 'queued', next_attempt_at = now(), held_reason = NULL WHERE id = $1 AND status IN ('held', 'failed') RETURNING id`,
        [payoutId],
      );
      if (!r.rowCount) throw conflict('not_retryable', 'Only held or failed payouts can be retried.');
      await writeAudit(tx, { actorType: 'staff', actorId: s.staffId, actorRoles: s.roles, action: 'payout.retry', targetType: 'payout', targetId: payoutId, reason, ip: req.ip });
      return { status: 'queued' };
    });
  });

  app.post('/admin/payouts/manual', { config: finance }, async (req, reply) => {
    const s = staffActor(req);
    const body = parse(z.object({ workerId: z.string().uuid(), amountPaise: z.number().int().positive().max(5_000_000), reason: reasonField }).strict(), req.body);
    reply.code(201);
    return requestManualPayout(db, s, body, req.ip);
  });

  app.post('/admin/payouts/:payoutId/decide', { config: finance }, async (req) => {
    const s = staffActor(req);
    const { payoutId } = parse(uuidParam('payoutId'), req.params);
    const { decision, reason } = parse(z.object({ decision: z.enum(['approve', 'reject']), reason: reasonField }).strict(), req.body);
    return decideManualPayout(db, s, payoutId, decision === 'approve', reason, req.ip);
  });

  app.post('/admin/reconciliation/run', { config: finance }, async (req) => {
    const s = staffActor(req);
    const { date } = parse(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default(istDate(new Date())) }).strict(), req.body);
    return reconcile(db, date, s.staffId);
  });

  app.get('/admin/reconciliation', { config: finance }, async () => {
    const r = await db.query(`SELECT r.*, s.email FROM reconciliation_runs r LEFT JOIN staff_users s ON s.id = r.run_by ORDER BY r.created_at DESC LIMIT 60`);
    return r.rows.map((x) => ({ id: x.id, date: istDate(new Date(x.run_date)), providerNetPaise: Number(x.provider_net_paise), ledgerNetPaise: Number(x.ledger_net_paise), diffPaise: Number(x.diff_paise), status: x.status, runBy: x.email ?? 'scheduler', at: x.created_at }));
  });

  app.get('/admin/timesheets/disputed', { config: disputes }, async () => {
    const r = await db.query(
      `SELECT t.*, p.first_name, b.legal_name, s.title, rs.email AS proposed_by FROM timesheets t
         JOIN worker_profiles p ON p.user_id = t.worker_id JOIN businesses b ON b.id = t.business_id JOIN shifts s ON s.id = t.shift_id
         LEFT JOIN staff_users rs ON rs.id = t.resolved_by
        WHERE t.status IN ('disputed', 'partially_disputed') ORDER BY t.disputed_at`,
    );
    const ev = async (bookingId: string) => (await db.query(
      `SELECT type, mode, status, effective_at, distance_m, face_score, flags FROM attendance_events WHERE booking_id = $1 ORDER BY effective_at`, [bookingId])).rows;
    return Promise.all(r.rows.map(async (t) => ({
      id: t.id, worker: t.first_name, business: t.legal_name, shift: t.title, payableMinutes: t.payable_minutes + t.overtime_minutes,
      disputedMinutes: t.disputed_minutes, disputedPaise: Number(t.disputed_paise), category: t.dispute_category, reason: t.dispute_reason, at: t.disputed_at,
      proposal: t.resolution_minutes != null ? { minutes: t.resolution_minutes, reason: t.resolution_reason, by: t.proposed_by } : null,
      flags: t.flags, evidence: await ev(t.booking_id),
    })));
  });

  app.post('/admin/timesheets/:timesheetId/resolve', { config: disputes }, async (req) => {
    const s = staffActor(req);
    const { timesheetId } = parse(uuidParam('timesheetId'), req.params);
    const body = parse(z.object({ awardMinutes: z.number().int().min(0).max(1000), reason: reasonField }).strict(), req.body);
    return resolveDispute(db, timesheetId, s, body, req.ip);
  });

  app.post('/admin/timesheets/:timesheetId/confirm-resolution', { config: disputes }, async (req) => {
    const s = staffActor(req);
    const { timesheetId } = parse(uuidParam('timesheetId'), req.params);
    return resolveDispute(db, timesheetId, s, 'confirm', req.ip);
  });
}
