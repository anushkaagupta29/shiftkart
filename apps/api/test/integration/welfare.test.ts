// Gig-worker welfare contribution (LEGAL L-02, L-03; working assumption D-089):
// paid by the business on top of the shift cost, never deducted from the worker.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeApp, makeApp, resetData, type Ctx } from '../helpers';
import { clock, fund, liveShift, onShift, postShift, runJobs, seedRates, startShiftAgo, verifiedBusiness, workedShift, type Biz } from '../fixtures';
import { accountBalance, shiftEscrow, welfarePayable, workerPayable } from '../../src/ledger';
import { reconcile } from '../../src/money';
import { istDate } from '../../src/time';

let ctx: Ctx;
let b: Biz;
const setPolicy = (key: string, value: number, scope = 'global') =>
  ctx.db.query(`INSERT INTO policy_config (key, scope, value, reason, effective_from) VALUES ($1, $2, $3, 'test', now() - interval '1 second')`, [key, scope, JSON.stringify(value)]);

beforeAll(async () => {
  ctx = await makeApp();
  await resetData(ctx.db);
  await seedRates(ctx);
  b = await verifiedBusiness(ctx);
});
afterAll(async () => closeApp(ctx));

describe('with the default rate of 0', () => {
  it('nothing changes: no welfare in the cost, no welfare accounts, no welfare on the invoice', async () => {
    const s = await workedShift(ctx, b, { headcount: 1 });
    expect(s.shift.cost).toMatchObject({ welfareCentralPaise: 0, welfareStatePaise: 0 });
    await ctx.app.inject({ method: 'POST', url: `/businesses/${b.businessId}/timesheets/${s.timesheet.id}/approve`, headers: b.owner.auth });
    await startShiftAgo(ctx, s.shift.id, 8 * 60 + 200);
    await runJobs(ctx);
    const acc = await ctx.db.query(`SELECT 1 FROM ledger_accounts WHERE code LIKE 'welfare_payable:%'`);
    expect(acc.rowCount).toBe(0);
    const inv = (await ctx.app.inject({ method: 'GET', url: `/businesses/${b.businessId}/invoices`, headers: b.owner.auth })).json();
    expect(inv.find((i: { shiftId: string }) => i.shiftId === s.shift.id)).toMatchObject({ passThroughPaise: 0, totalPaise: 13275 });
  });
});

describe('with rates set (1% central, 0.5% Karnataka)', () => {
  beforeAll(async () => {
    await setPolicy('welfare.central_bp', 100);
    await setPolicy('welfare.state_bp', 50, 'state:KA');
  });
  afterAll(async () => {
    await setPolicy('welfare.central_bp', 0);
    await setPolicy('welfare.state_bp', 0, 'state:KA');
  });

  it('the business pays it on top; the worker is paid in full; it lands in the welfare accounts and on the invoice', async () => {
    const s = await workedShift(ctx, b, { headcount: 2 }); // 2 funded, 1 worked
    // Per worker: pay ₹750 → central ₹7.50, KA ₹3.75.
    expect(s.shift.cost).toMatchObject({ welfareCentralPaise: 1500, welfareStatePaise: 750, welfareState: 'KA' });
    expect(s.shift.cost.totalPaise).toBe(186550 + 2250);
    expect(s.timesheet).toMatchObject({ welfare_central_bp: 100, welfare_state_bp: 50, welfare_state: 'KA' });

    const ap = await ctx.app.inject({ method: 'POST', url: `/businesses/${b.businessId}/timesheets/${s.timesheet.id}/approve`, headers: b.owner.auth });
    expect(ap.json()).toEqual({ status: 'approved', payoutPaise: 80000 }); // no deduction
    await runJobs(ctx);
    const slips = (await ctx.app.inject({ method: 'GET', url: '/worker/payslips', headers: s.worker.auth })).json();
    const slip = (await ctx.app.inject({ method: 'GET', url: `/worker/payslips/${slips.items[0].id}`, headers: s.worker.auth })).json();
    expect(slip).toMatchObject({ grossPaise: 80000, deductionsPaise: 0, netPaise: 80000 });

    const central0 = await accountBalance(ctx.db, welfarePayable('central'));
    const ka0 = await accountBalance(ctx.db, welfarePayable('KA'));
    expect(central0).toBe(750);
    expect(ka0).toBe(375);

    // Settle: the unworked slot's money, including its welfare, goes back to the business.
    await startShiftAgo(ctx, s.shift.id, 8 * 60 + 200);
    await runJobs(ctx);
    expect(await accountBalance(ctx.db, shiftEscrow(s.shift.id))).toBe(0);
    const money = (await ctx.app.inject({ method: 'GET', url: `/businesses/${b.businessId}/shifts/${s.shift.id}/money`, headers: b.owner.auth })).json();
    expect(money).toMatchObject({ fundedPaise: 188800, releasedPaise: 94400, refundedPaise: 94400, heldPaise: 0 });
    const inv = (await ctx.app.inject({ method: 'GET', url: `/businesses/${b.businessId}/invoices`, headers: b.owner.auth })).json()
      .find((i: { shiftId: string }) => i.shiftId === s.shift.id);
    expect(inv).toMatchObject({ taxablePaise: 11250, cgstPaise: 1012, sgstPaise: 1013, passThroughPaise: 1125, totalPaise: 14400 });
    expect(inv.lines.map((l: { description: string }) => l.description)).toEqual([
      expect.stringMatching(/^Platform fee/), expect.stringMatching(/welfare contribution \(central\)/), expect.stringMatching(/welfare contribution \(KA\)/),
    ]);
    expect(await accountBalance(ctx.db, workerPayable(s.worker.userId))).toBe(0);
    expect((await ctx.db.query('SELECT 1 FROM ledger_entries GROUP BY journal_id HAVING sum(amount_paise) <> 0')).rowCount).toBe(0);
    expect((await reconcile(ctx.db, istDate(new Date()))).status).toBe('matched');
  });

  it('a partly disputed timesheet holds the welfare on the disputed pay, like the fee', async () => {
    const s = await workedShift(ctx, b, { headcount: 1 });
    const before = await accountBalance(ctx.db, welfarePayable('central'));
    const d = await ctx.app.inject({ method: 'POST', url: `/businesses/${b.businessId}/timesheets/${s.timesheet.id}/dispute`, headers: b.owner.auth, payload: { minutes: 90, category: 'left_early', reason: 'Left the site 90 minutes before the end.' } });
    expect(d.statusCode).toBe(200);
    // 90 of 450 min disputed → ₹150 held; welfare released on ₹600 only: central ₹6.00.
    expect(await accountBalance(ctx.db, welfarePayable('central')) - before).toBe(600);
  });

  it('overtime top-ups include welfare on the overtime pay', async () => {
    const s = await onShift(ctx, b);
    await clock(ctx, s.worker, s.bookingId, s.shift.id, 'check-in');
    const ot = await ctx.app.inject({ method: 'POST', url: `/businesses/${b.businessId}/bookings/${s.bookingId}/overtime`, headers: b.owner.auth, payload: { extraMinutes: 60 } });
    expect(ot.statusCode).toBe(201);
    // ₹200 overtime → fee ₹30, GST ₹5.40, welfare ₹2 + ₹1.
    expect(ot.json()).toMatchObject({ workerPayPaise: 20000, totalPaise: 20000 + 3000 + 540 + 300 });
  });

  it('a cancelled shift refunds everything, welfare included', async () => {
    const shift = await postShift(ctx, b, { headcount: 3 });
    await fund(ctx, b, shift.id);
    const c = await ctx.app.inject({ method: 'POST', url: `/businesses/${b.businessId}/shifts/${shift.id}/cancel`, headers: b.owner.auth, payload: { reason: 'Event called off' } });
    expect(c.statusCode).toBe(200);
    await runJobs(ctx);
    expect(await accountBalance(ctx.db, shiftEscrow(shift.id))).toBe(0);
    const refunded = (await ctx.db.query(`SELECT COALESCE(sum(amount_paise), 0)::int AS r FROM refunds WHERE shift_id = $1`, [shift.id])).rows[0].r;
    expect(refunded).toBe(shift.cost.totalPaise);
  });

  it('the state rate comes from the site’s state (scope state:KA)', async () => {
    const s = await liveShift(ctx, b, { headcount: 1 });
    expect(s.cost.welfareStateBp).toBe(50); // the test site is in KA
  });
});
