// Phase 3 end to end through the API: check in → break → check out → approve → paid → payslip →
// shift settles (unused money refunded, GST invoice issued) → reconciliation matches.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, makeApp, resetData, type Ctx } from '../helpers';
import { clock, onShift, runJobs, seedRates, startShiftAgo, verifiedBusiness, workedShift, type Biz } from '../fixtures';
import { accountBalance, shiftEscrow, workerPayable } from '../../src/ledger';
import { reconcile } from '../../src/money';
import { istDate } from '../../src/time';

let ctx: Ctx;
let b: Biz;
beforeAll(async () => { ctx = await makeApp(); await resetData(ctx.db); await seedRates(ctx); b = await verifiedBusiness(ctx); });
afterAll(async () => closeApp(ctx));

describe('Phase 3 journey', () => {
  it('gate key only during the shift window; check-in, break, roster view', async () => {
    const s = await onShift(ctx, b);
    const gate = await ctx.app.inject({ method: 'GET', url: `/businesses/${b.businessId}/shifts/${s.shift.id}/gate`, headers: b.owner.auth });
    expect(gate.statusCode).toBe(200);
    expect(gate.json().keyB64).toBeTruthy();

    const ci = await clock(ctx, s.worker, s.bookingId, s.shift.id, 'check-in');
    expect(ci.statusCode).toBe(200);
    expect(ci.json()).toMatchObject({ status: 'accepted', flags: [] });

    expect((await ctx.app.inject({ method: 'POST', url: `/worker/bookings/${s.bookingId}/break`, headers: s.worker.auth, payload: { action: 'start' } })).json()).toEqual({ onBreak: true });
    expect((await ctx.app.inject({ method: 'POST', url: `/worker/bookings/${s.bookingId}/break`, headers: s.worker.auth, payload: { action: 'start' } })).statusCode).toBe(409);
    await ctx.app.inject({ method: 'POST', url: `/worker/bookings/${s.bookingId}/break`, headers: s.worker.auth, payload: { action: 'end' } });

    const roster = (await ctx.app.inject({ method: 'GET', url: `/businesses/${b.businessId}/shifts/${s.shift.id}/attendance`, headers: b.owner.auth })).json();
    expect(roster[0]).toMatchObject({ firstName: 'Ravi', status: 'checked_in', onBreak: false, flags: [] });
    expect(JSON.stringify(roster)).not.toMatch(/lat|lng|score/);

    // Gate closed for a shift far in the future.
    const future = (await import('../fixtures')).liveShift;
    const later = await future(ctx, b, { startsAt: (await import('../fixtures')).istSlot(5, 9), endsAt: (await import('../fixtures')).istSlot(5, 17) });
    expect((await ctx.app.inject({ method: 'GET', url: `/businesses/${b.businessId}/shifts/${later.id}/gate`, headers: b.owner.auth })).json().error.code).toBe('gate_closed');
  });

  it('full day → timesheet → approve → paid → payslip → settled with refund and GST invoice', async () => {
    const s = await workedShift(ctx, b, { headcount: 2 }); // 2 funded, 1 worked → half the money comes back
    expect(s.timesheet).toMatchObject({ payable_minutes: 450, status: 'pending_approval' });
    expect(Number(s.timesheet.gross_paise)).toBe(80000); // 7.5 h × ₹100 + ₹50 meal

    const list = (await ctx.app.inject({ method: 'GET', url: `/businesses/${b.businessId}/timesheets`, headers: b.owner.auth })).json();
    const ts = list.find((t: { id: string }) => t.id === s.timesheet.id);
    expect(ts).toMatchObject({ firstName: 'Ravi', payableMinutes: 450, grossPaise: 80000 });

    const ap = await ctx.app.inject({ method: 'POST', url: `/businesses/${b.businessId}/timesheets/${ts.id}/approve`, headers: b.owner.auth });
    expect(ap.json()).toEqual({ status: 'approved', payoutPaise: 80000 });
    expect((await ctx.app.inject({ method: 'POST', url: `/businesses/${b.businessId}/timesheets/${ts.id}/approve`, headers: b.owner.auth })).statusCode).toBe(409);

    await runJobs(ctx);
    const slips = (await ctx.app.inject({ method: 'GET', url: '/worker/payslips', headers: s.worker.auth })).json();
    expect(slips.items).toHaveLength(1);
    const slip = (await ctx.app.inject({ method: 'GET', url: `/worker/payslips/${slips.items[0].id}`, headers: s.worker.auth })).json();
    expect(slip).toMatchObject({ netPaise: 80000, grossPaise: 80000, deductionsPaise: 0 });
    expect(slip.lines.map((l: { label: string }) => l.label)).toEqual(['Base pay', 'Meal allowance']);
    expect(slip.paidTo).toMatch(/\*\*\*\*@/);
    expect(await accountBalance(ctx.db, workerPayable(s.worker.userId))).toBe(0);

    // Settle: the unworked slot (1 of 2) is refunded; the fee for the worked one is invoiced.
    await startShiftAgo(ctx, s.shift.id, 8 * 60 + 200);
    await runJobs(ctx);
    expect(await accountBalance(ctx.db, shiftEscrow(s.shift.id))).toBe(0);
    const money = (await ctx.app.inject({ method: 'GET', url: `/businesses/${b.businessId}/shifts/${s.shift.id}/money`, headers: b.owner.auth })).json();
    // funded: 2 × (75000 + 5000) + fee 2 × 11250 + gst 2 × 2025 = 186550; used: 80000 + 11250 + 2025 = 93275
    expect(money).toMatchObject({ fundedPaise: 186550, releasedPaise: 93275, refundedPaise: 93275, heldPaise: 0 });
    const inv = (await ctx.app.inject({ method: 'GET', url: `/businesses/${b.businessId}/invoices`, headers: b.owner.auth })).json();
    expect(inv[0]).toMatchObject({ taxablePaise: 11250, cgstPaise: 1012, sgstPaise: 1013, igstPaise: 0, totalPaise: 13275 });
    expect(inv[0].number).toMatch(/^INV\/\d{4}-\d{2}\/\d{6}$/);
    const shift = (await ctx.db.query('SELECT status FROM shifts WHERE id = $1', [s.shift.id])).rows[0];
    expect(shift.status).toBe('completed');

    // Every journal balances, and the provider's books match ours for today.
    expect((await ctx.db.query('SELECT 1 FROM ledger_entries GROUP BY journal_id HAVING sum(amount_paise) <> 0')).rowCount).toBe(0);
    expect((await reconcile(ctx.db, istDate(new Date()))).status).toBe('matched');
  });
});
