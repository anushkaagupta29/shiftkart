import { applyBasisPoints, assertPaise, type Paise } from '@shiftkart/shared';

export type PayType = 'hourly' | 'per_shift';

export type CostInput = {
  payType: PayType;
  payPaise: Paise;
  startsAt: Date;
  endsAt: Date;
  breakMinutes: number;
  headcount: number;
  mealAllowancePaise: Paise;
  travelAllowancePaise: Paise;
  feeBp: number;
  gstBp: number;
};

export type ShiftCost = {
  paidMinutes: number;
  perWorkerPayPaise: Paise;
  perWorkerAllowancesPaise: Paise;
  effectiveHourlyPaise: Paise;
  workerPayTotalPaise: Paise;
  allowancesTotalPaise: Paise;
  feePaise: Paise;
  gstOnFeePaise: Paise;
  totalPaise: Paise;
  feeBp: number;
  gstBp: number;
};

/** (a × b) / c rounded half-up, integer-only. */
function mulDivRound(a: number, b: number, c: number): number {
  const n = BigInt(a) * BigInt(b);
  const d = BigInt(c);
  return Number((n * 2n + d) / (d * 2n));
}

export function paidMinutes(startsAt: Date, endsAt: Date, breakMinutes: number): number {
  const total = (endsAt.getTime() - startsAt.getTime()) / 60_000;
  if (!Number.isInteger(total)) throw new RangeError('shift times must be whole minutes');
  const paid = total - breakMinutes;
  if (paid <= 0) throw new RangeError('break is longer than the shift');
  return paid;
}

/**
 * What the business pays to fund a shift (SPEC §6.3):
 * worker pay + allowances + platform fee (on worker pay only) + GST on the fee.
 */
export function computeShiftCost(i: CostInput): ShiftCost {
  for (const [k, v] of Object.entries({ pay: i.payPaise, meal: i.mealAllowancePaise, travel: i.travelAllowancePaise })) assertPaise(v, k);
  const minutes = paidMinutes(i.startsAt, i.endsAt, i.breakMinutes);
  const perWorkerPay = i.payType === 'hourly' ? mulDivRound(i.payPaise, minutes, 60) : i.payPaise;
  const effectiveHourly = i.payType === 'hourly' ? i.payPaise : Math.floor((i.payPaise * 60) / minutes);
  const perWorkerAllowances = i.mealAllowancePaise + i.travelAllowancePaise;
  const workerPayTotal = perWorkerPay * i.headcount;
  const allowancesTotal = perWorkerAllowances * i.headcount;
  const fee = applyBasisPoints(workerPayTotal, i.feeBp);
  const gst = applyBasisPoints(fee, i.gstBp);
  return {
    paidMinutes: minutes,
    perWorkerPayPaise: perWorkerPay,
    perWorkerAllowancesPaise: perWorkerAllowances,
    effectiveHourlyPaise: effectiveHourly,
    workerPayTotalPaise: workerPayTotal,
    allowancesTotalPaise: allowancesTotal,
    feePaise: fee,
    gstOnFeePaise: gst,
    totalPaise: assertPaise(workerPayTotal + allowancesTotal + fee + gst, 'total'),
    feeBp: i.feeBp,
    gstBp: i.gstBp,
  };
}

export type WageRate = { basicPaisePerDay: number; vdaPaisePerDay: number; standardHoursPerDay: number };

/** Minimum hourly base pay, rounded up so a business can never land a paisa under. */
export function minHourlyPaise(rate: WageRate): number {
  const daily = BigInt(rate.basicPaisePerDay + rate.vdaPaisePerDay);
  const h = BigInt(rate.standardHoursPerDay);
  return Number((daily + h - 1n) / h);
}

/**
 * PAY-04: only base pay counts toward the minimum wage. Allowances are never included.
 * Compares pay-per-minute against the daily minimum spread over standard hours, in integers.
 */
export function meetsMinimumWage(payType: PayType, payPaise: number, minutes: number, rate: WageRate): boolean {
  const daily = BigInt(rate.basicPaisePerDay + rate.vdaPaisePerDay);
  const stdMinutes = BigInt(rate.standardHoursPerDay * 60);
  const pay = BigInt(payPaise);
  const m = BigInt(minutes);
  // Base pay for the paid minutes must be ≥ daily × minutes / stdMinutes. Cross-multiplied to stay integer:
  //   hourly:    pay × m / 60 ≥ daily × m / stdMinutes  ⇔  pay × stdMinutes ≥ daily × 60
  //   per_shift: pay          ≥ daily × m / stdMinutes  ⇔  pay × stdMinutes ≥ daily × m
  return payType === 'hourly' ? pay * stdMinutes >= daily * 60n : pay * stdMinutes >= daily * m;
}

const CATEGORY_ORDER = ['unskilled', 'semi_skilled', 'skilled'] as const;
export type WageCategory = (typeof CATEGORY_ORDER)[number];

/** PAY-05: the wage category is the highest of the role's and any required skill's category. */
export function resolveWageCategory(roleCategory: WageCategory, skillCategories: WageCategory[]): WageCategory {
  return [roleCategory, ...skillCategories].reduce((a, b) => (CATEGORY_ORDER.indexOf(b) > CATEGORY_ORDER.indexOf(a) ? b : a));
}
