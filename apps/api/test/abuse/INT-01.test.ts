// INT-01: admins can't silently change records. Audit log is append-only and tamper-evident.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { audit, verifyAuditChain } from '../../src/audit';
import { closeApp, makeApp, resetData, signUp, staffWith, type Ctx } from '../helpers';

let ctx: Ctx;
beforeAll(async () => { ctx = await makeApp(); await resetData(ctx.db); });
afterAll(async () => closeApp(ctx));

describe('INT-01 audit log integrity', () => {
  it('rejects UPDATE and DELETE on audit_log, even from the app database user', async () => {
    await audit(ctx.db, { actorType: 'system', action: 'test.event' });
    await expect(ctx.db.query(`UPDATE audit_log SET reason = 'changed'`)).rejects.toThrow(/append-only/);
    await expect(ctx.db.query('DELETE FROM audit_log')).rejects.toThrow(/append-only/);
  });

  it('policy values are append-only too (changes are new versions)', async () => {
    await ctx.db.query(`INSERT INTO policy_config (key, value, reason) VALUES ('x.test', '1', 'test value')`);
    await expect(ctx.db.query(`UPDATE policy_config SET value = '2' WHERE key = 'x.test'`)).rejects.toThrow(/append-only/);
  });

  it('detects a tampered row via the hash chain', async () => {
    const support = await staffWith(ctx, ['ops_safety']);
    const w = await signUp(ctx, 'worker');
    await ctx.app.inject({ method: 'POST', url: `/admin/users/${w.userId}/status`, headers: support.cookie, payload: { status: 'limited', reason: 'Testing tamper detection' } });
    expect((await verifyAuditChain(ctx.db)).ok).toBe(true);

    // Simulate someone with database superuser access editing history.
    const client = await ctx.db.connect();
    try {
      await client.query('ALTER TABLE audit_log DISABLE TRIGGER audit_log_append_only');
      await client.query(`UPDATE audit_log SET after = '{"status":"active"}' WHERE action = 'user.status_change'`);
      await client.query('ALTER TABLE audit_log ENABLE TRIGGER audit_log_append_only');
    } finally {
      client.release();
    }
    const res = await verifyAuditChain(ctx.db);
    expect(res.ok).toBe(false);
    expect(res.brokenAtSeq).toBeGreaterThan(0);
  });

  it('keeps a valid chain under concurrent writes', async () => {
    await resetData(ctx.db);
    await Promise.all(Array.from({ length: 25 }, (_, i) => audit(ctx.db, { actorType: 'system', action: `concurrent.${i}` })));
    const res = await verifyAuditChain(ctx.db);
    expect(res).toEqual({ ok: true, checked: 25 });
  });

  it('every admin write requires a reason and is logged with who did it', async () => {
    const safety = await staffWith(ctx, ['ops_safety']);
    const w = await signUp(ctx, 'worker');
    const noReason = await ctx.app.inject({ method: 'POST', url: `/admin/users/${w.userId}/status`, headers: safety.cookie, payload: { status: 'suspended' } });
    expect(noReason.statusCode).toBe(400);
    const ok = await ctx.app.inject({ method: 'POST', url: `/admin/users/${w.userId}/status`, headers: safety.cookie, payload: { status: 'suspended', reason: 'Fraud report #123' } });
    expect(ok.statusCode).toBe(200);
    // Workers get a removal notice first (D-091); see removal-notice.test.ts.
    const row = (await ctx.db.query(`SELECT * FROM audit_log WHERE action = 'worker.removal_notice' AND target_id = $1`, [w.userId])).rows[0];
    expect(row).toMatchObject({ actor_id: safety.staffId, reason: 'Fraud report #123' });
    // Other accounts are suspended at once, and that kills their sessions.
    const biz = await signUp(ctx, 'business');
    await ctx.app.inject({ method: 'POST', url: `/admin/users/${biz.userId}/status`, headers: safety.cookie, payload: { status: 'suspended', reason: 'Fraud report #124' } });
    const row2 = (await ctx.db.query(`SELECT * FROM audit_log WHERE action = 'user.status_change' AND target_id = $1`, [biz.userId])).rows[0];
    expect(row2).toMatchObject({ actor_id: safety.staffId, reason: 'Fraud report #124', before: { status: 'active' }, after: { status: 'suspended' } });
    expect((await ctx.app.inject({ method: 'GET', url: '/me', headers: biz.auth })).statusCode).toBe(401);
  });

  it("super admins can't change their own roles", async () => {
    const sa = await staffWith(ctx, ['super_admin']);
    const r = await ctx.app.inject({ method: 'POST', url: `/admin/staff/${sa.staffId}/roles`, headers: sa.cookie, payload: { roles: ['super_admin', 'finance'], reason: 'Self escalation attempt' } });
    expect(r.statusCode).toBe(403);
  });
});
