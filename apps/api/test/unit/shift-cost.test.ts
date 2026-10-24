import { describe, expect, it } from 'vitest';
import { computeShiftCost, meetsMinimumWage, minHourlyPaise, resolveWageCategory } from '../../src/domain/shift-cost';
import { screenText } from '../../src/domain/text-screen';

const at = (h: number, m = 0) => new Date(Date.UTC(2026, 10, 1, h, m));
const base = {
  payType: 'hourly' as const, payPaise: 10000, startsAt: at(3, 30), endsAt: at(11, 30), breakMinutes: 30,
  headcount: 10, mealAllowancePaise: 5000, travelAllowancePaise: 0, feeBp: 1500, gstBp: 1800,
};

describe('computeShiftCost', () => {
  it('worked example: 8h shift, 30 min break, ₹100/h, 10 people, ₹50 meal', () => {
    const c = computeShiftCost(base);
    expect(c.paidMinutes).toBe(450);
    expect(c.perWorkerPayPaise).toBe(75000);       // 7.5h × ₹100
    expect(c.workerPayTotalPaise).toBe(750000);     // × 10
    expect(c.allowancesTotalPaise).toBe(50000);     // ₹50 × 10, no fee on allowances
    expect(c.feePaise).toBe(112500);                // 15% of ₹7,500
    expect(c.gstOnFeePaise).toBe(20250);            // 18% of ₹1,125
    expect(c.totalPaise).toBe(750000 + 50000 + 112500 + 20250);
  });

  it('welfare contributions are on worker pay only, rounded per worker, and added on top (D-089)', () => {
    const c = computeShiftCost({ ...base, welfareCentralBp: 100, welfareStateBp: 33 });
    expect(c.welfareCentralPaise).toBe(7500);      // 1% of ₹750 × 10
    expect(c.welfareStatePaise).toBe(2480);        // 0.33% of ₹750 = ₹2.475 → ₹2.48 per worker, × 10
    expect(c.perWorkerPayPaise).toBe(75000);       // the worker's pay is untouched
    expect(c.totalPaise).toBe(750000 + 50000 + 112500 + 20250 + 7500 + 2480);
    expect(computeShiftCost(base)).toMatchObject({ welfareCentralPaise: 0, welfareStatePaise: 0, welfareCentralBp: 0, welfareStateBp: 0 });
  });

  it('per-shift pay is not multiplied by hours', () => {
    const c = computeShiftCost({ ...base, payType: 'per_shift', payPaise: 80000 });
    expect(c.perWorkerPayPaise).toBe(80000);
    expect(c.effectiveHourlyPaise).toBe(10666); // floor(80000 × 60 / 450)
  });

  it('rounds odd minutes half-up and stays integer', () => {
    const c = computeShiftCost({ ...base, payPaise: 9999, endsAt: at(11, 37), breakMinutes: 0 });
    expect(Number.isInteger(c.perWorkerPayPaise)).toBe(true);
    expect(c.perWorkerPayPaise).toBe(Math.round((9999 * 487) / 60));
  });

  it('rejects breaks longer than the shift and fractional minutes', () => {
    expect(() => computeShiftCost({ ...base, breakMinutes: 600 })).toThrow();
    expect(() => computeShiftCost({ ...base, endsAt: new Date(at(11).getTime() + 1500) })).toThrow();
    expect(() => computeShiftCost({ ...base, payPaise: 100.5 })).toThrow();
  });
});

describe('minimum wage (PAY-04)', () => {
  const rate = { basicPaisePerDay: 60000, vdaPaisePerDay: 4000, standardHoursPerDay: 8 }; // SAMPLE: ₹640/day → ₹80/h
  it('computes min hourly rounded up', () => {
    expect(minHourlyPaise(rate)).toBe(8000);
    expect(minHourlyPaise({ ...rate, vdaPaisePerDay: 4001 })).toBe(8001);
  });
  it('hourly: exactly the minimum passes, one paisa under fails', () => {
    expect(meetsMinimumWage('hourly', 8000, 450, rate)).toBe(true);
    expect(meetsMinimumWage('hourly', 7999, 450, rate)).toBe(false);
  });
  it('per-shift: judged over the paid minutes', () => {
    expect(meetsMinimumWage('per_shift', 60000, 450, rate)).toBe(true);  // ₹600 for 7.5h = ₹80/h
    expect(meetsMinimumWage('per_shift', 59999, 450, rate)).toBe(false);
  });
  it('allowances are never part of the check (the function never sees them)', () => {
    // ₹50/h base + ₹300 meal "allowance" would look like ₹90/h if allowances counted.
    expect(meetsMinimumWage('hourly', 5000, 450, rate)).toBe(false);
  });
});

describe('wage category (PAY-05)', () => {
  it('a skilled requirement raises the category', () => {
    expect(resolveWageCategory('unskilled', [])).toBe('unskilled');
    expect(resolveWageCategory('unskilled', ['semi_skilled', 'unskilled'])).toBe('semi_skilled');
    expect(resolveWageCategory('semi_skilled', ['unskilled'])).toBe('semi_skilled');
  });
});

describe('text screening', () => {
  it.each([
    ['Need fair skinned girls for promo', ['discriminatory_language']],
    ['Hindus only please', ['discriminatory_language']],
    ['केवल लड़कियां', ['discriminatory_language']],
    ['Pay ₹500 registration fee to confirm', ['worker_payment_request']],
    ['Bring uniform deposit ₹300', ['worker_payment_request']],
    ['Send aadhaar photo on whatsapp', ['document_request']],
    ['Escort service for party', ['prohibited_work']],
    ['Firecracker packing, Diwali', ['prohibited_work']],
  ])('%s', (text, reasons) => {
    expect(screenText(text)).toEqual(reasons);
  });
  it('lets ordinary posts through', () => {
    expect(screenText('Pack and label parcels for Big Billion Days', 'Black shoes, white shirt', 'Water bottle')).toEqual([]);
    expect(screenText('Billing counter at a supermarket, Kannada or Hindi speakers')).toEqual([]);
  });
});
