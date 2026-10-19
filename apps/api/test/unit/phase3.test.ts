import { describe, expect, it } from 'vitest';
import { computeTimesheet, payForMinutes } from '../../src/domain/timesheet';
import { gateCode, qrPayload, qrStep, shiftKey, verifyGateCode } from '../../src/domain/qr';
import { financialYear, gstSplit } from '../../src/domain/gst';

const at = (h: number, m = 0) => new Date(Date.UTC(2026, 10, 2, h, m));
const base = { scheduledStart: at(4), scheduledEnd: at(12), postedBreakMinutes: 30, checkIn: at(3, 50), checkOut: at(12, 5), breaks: [{ start: at(8), end: at(8, 30) }], acceptedOvertimeMinutes: 0 };
const pay = { payType: 'hourly' as const, payPaise: 10000, mealAllowancePaise: 5000, travelAllowancePaise: 0, overtimeMultiplierBp: 20000 };

describe('timesheet', () => {
  it('normal day: early arrival and 5 min late leaving are not paid; break deducted', () => {
    const t = computeTimesheet(base, pay);
    expect(t.payableMinutes).toBe(450);
    expect(t.basePayPaise).toBe(75000);
    expect(t.overtimeMinutes).toBe(0);
    expect(t.stayedLateMinutes).toBe(5);
    expect(t.grossPaise).toBe(80000);
  });

  it('late arrival and early leaving reduce pay', () => {
    const t = computeTimesheet({ ...base, checkIn: at(4, 20), checkOut: at(11, 30) }, pay);
    expect(t.payableMinutes).toBe(400); // 4:20→11:30 = 430 − 30 recorded break
    expect(t.basePayPaise).toBe(Math.round(400 * 10000 / 60));
  });

  it('the posted break is deducted pro rata; longer recorded breaks are capped at it', () => {
    expect(computeTimesheet({ ...base, breaks: [{ start: at(8), end: at(9) }] }, pay).breakMinutes).toBe(30);
    expect(computeTimesheet({ ...base, breaks: [] }, pay).payableMinutes).toBe(450); // full day: same as funded
    expect(computeTimesheet({ ...base, breaks: [], checkOut: at(8) }, pay).breakMinutes).toBe(15); // half day
  });

  it('never pays more than the shift was funded for (no overtime)', () => {
    for (const [ci, co, brk] of [[at(3), at(13), 0], [at(4), at(12), 0], [at(4), at(12), 90]] as const) {
      const t = computeTimesheet({ ...base, checkIn: ci, checkOut: co, breaks: brk ? [{ start: at(6), end: new Date(at(6).getTime() + brk * 60_000) }] : [] }, pay);
      expect(t.basePayPaise).toBeLessThanOrEqual(75000);
    }
  });

  it('an open break is closed at check-out (and the posted break still applies)', () => {
    const t = computeTimesheet({ ...base, checkOut: at(12), breaks: [{ start: at(11, 50), end: null }] }, pay);
    expect(t.breakMinutes).toBe(30);
  });

  it('agreed overtime is paid at 2×, only up to what was agreed', () => {
    const t = computeTimesheet({ ...base, acceptedOvertimeMinutes: 60, checkOut: at(13, 30) }, pay);
    expect(t.overtimeMinutes).toBe(60);
    expect(t.overtimePayPaise).toBe(20000); // 60 min × ₹100/h × 2
    expect(t.stayedLateMinutes).toBe(30);
  });

  it('per-shift pay is pro-rated and capped', () => {
    const ps = { ...pay, payType: 'per_shift' as const, payPaise: 90000 };
    expect(computeTimesheet(base, ps).basePayPaise).toBe(90000);
    // Left at 08:00: 240 min span, 15 min pro-rata break → 225 of 450 paid minutes.
    expect(computeTimesheet({ ...base, checkOut: at(8) }, ps).basePayPaise).toBe(45000);
  });

  it('pay for disputed minutes is proportional', () => {
    const t = computeTimesheet(base, pay);
    expect(payForMinutes(t, 45)).toBe(7500);
    expect(payForMinutes(t, 10_000)).toBe(75000);
  });
});

describe('gate codes (WRK-05)', () => {
  const key = shiftKey('site-secret', 'shift-1');
  const now = 1_800_000_000_000;
  it('accepts the current code and its neighbours, rejects older ones', () => {
    const s = qrStep(now);
    expect(verifyGateCode(key, 'shift-1', gateCode(key, s), now).ok).toBe(true);
    expect(verifyGateCode(key, 'shift-1', gateCode(key, s - 1), now).ok).toBe(true);
    expect(verifyGateCode(key, 'shift-1', gateCode(key, s - 3), now).ok).toBe(false);
  });
  it('a QR payload is bound to its shift and time', () => {
    const s = qrStep(now);
    expect(verifyGateCode(key, 'shift-1', qrPayload(key, 'shift-1', s), now)).toEqual({ ok: true, step: s });
    expect(verifyGateCode(key, 'shift-2', qrPayload(key, 'shift-1', s), now)).toEqual({ ok: false, reason: 'wrong_shift' });
    expect(verifyGateCode(key, 'shift-1', qrPayload(key, 'shift-1', s - 10), now)).toEqual({ ok: false, reason: 'expired' });
    expect(verifyGateCode(key, 'shift-1', `sk1.shift-1.${s}.000000`, now).ok).toBe(gateCode(key, s) === '000000');
  });
  it("another shift's key produces different codes", () => {
    const other = shiftKey('site-secret', 'shift-2');
    expect(gateCode(key, 5)).not.toBe(gateCode(other, 5));
  });
});

describe('GST and financial year', () => {
  it('intra-state splits CGST/SGST; inter-state is IGST', () => {
    expect(gstSplit(112500, 1800, 'KA', 'KA')).toEqual({ cgst: 10125, sgst: 10125, igst: 0, total: 20250 });
    expect(gstSplit(112501, 1800, 'KA', 'KA').total).toBe(20250);
    expect(gstSplit(112500, 1800, 'KA', 'MH')).toEqual({ cgst: 0, sgst: 0, igst: 20250, total: 20250 });
  });
  it('financial year flips on 1 April IST', () => {
    expect(financialYear(new Date('2026-03-31T18:29:00Z'))).toBe('2025-26'); // 23:59 IST, 31 March
    expect(financialYear(new Date('2026-03-31T18:30:00Z'))).toBe('2026-27'); // 00:00 IST, 1 April
  });
});
