// Turns attendance into payable time and money. Pure functions: no database, no clock.
// All money is integer paise; all times are UTC instants.

export type AttendanceInput = {
  scheduledStart: Date;
  scheduledEnd: Date;
  postedBreakMinutes: number;
  checkIn: Date;
  checkOut: Date;
  breaks: { start: Date; end: Date | null }[];
  acceptedOvertimeMinutes: number;
};

export type PayInput = {
  payType: 'hourly' | 'per_shift';
  payPaise: number;
  mealAllowancePaise: number;
  travelAllowancePaise: number;
  overtimeMultiplierBp: number;
};

export type TimesheetCalc = {
  startedAt: Date;
  endedAt: Date;
  breakMinutes: number;
  payableMinutes: number;       // within scheduled hours, after breaks
  overtimeMinutes: number;      // agreed overtime actually worked
  stayedLateMinutes: number;    // after the end with no agreed overtime (unpaid → flag, PAY-06)
  basePayPaise: number;
  overtimePayPaise: number;
  allowancesPaise: number;
  grossPaise: number;
};

const minutesBetween = (a: Date, b: Date) => Math.max(0, Math.floor((b.getTime() - a.getTime()) / 60_000));
const mulDivRound = (a: number, b: number, c: number) => Number((BigInt(a) * BigInt(b) * 2n + BigInt(c)) / (BigInt(c) * 2n));

/**
 * Paid time runs from the later of check-in and scheduled start, to the earlier of check-out and
 * scheduled end (plus agreed overtime). The posted unpaid break is deducted pro rata to time worked. Arriving early or staying late without agreed overtime is not paid; staying
 * late is reported so the worker can be asked about it (PAY-06).
 */
export function computeTimesheet(a: AttendanceInput, p: PayInput): TimesheetCalc {
  const start = a.checkIn > a.scheduledStart ? a.checkIn : a.scheduledStart;
  const otEnd = new Date(a.scheduledEnd.getTime() + a.acceptedOvertimeMinutes * 60_000);
  const end = a.checkOut < otEnd ? a.checkOut : otEnd;
  const regularEnd = end < a.scheduledEnd ? end : a.scheduledEnd;

  let recordedBreak = 0;
  for (const b of a.breaks) {
    const bs = b.start < start ? start : b.start;
    const be = b.end ?? end;
    recordedBreak += minutesBetween(bs, be < end ? be : end);
  }
  // The posted unpaid break is part of the shift's terms (and what the business funded), so it is
  // deducted in proportion to the time worked: all of it for a full day, half for half a day.
  // A longer recorded break is still only deducted up to the posted break.
  const scheduledSpan = minutesBetween(a.scheduledStart, a.scheduledEnd);
  const span = minutesBetween(start, regularEnd);
  const proRata = scheduledSpan ? Math.round((a.postedBreakMinutes * Math.min(span, scheduledSpan)) / scheduledSpan) : 0;
  const breakMinutes = Math.min(a.postedBreakMinutes, Math.max(recordedBreak, proRata));
  const regularMinutes = Math.max(0, span - breakMinutes);
  const overtimeMinutes = minutesBetween(a.scheduledEnd, end);
  const stayedLateMinutes = minutesBetween(otEnd, a.checkOut);

  const scheduledPaid = minutesBetween(a.scheduledStart, a.scheduledEnd) - a.postedBreakMinutes;
  // Per-shift pay is pro-rated if less than the full shift was worked, and never exceeds the posted amount.
  const hourlyEquivalent = p.payType === 'hourly' ? p.payPaise : Math.floor((p.payPaise * 60) / scheduledPaid);
  const basePay = p.payType === 'hourly'
    ? mulDivRound(p.payPaise, regularMinutes, 60)
    : Math.min(p.payPaise, mulDivRound(p.payPaise, regularMinutes, scheduledPaid));
  const overtimePay = mulDivRound(hourlyEquivalent * overtimeMinutes, p.overtimeMultiplierBp, 60 * 10_000);
  const allowances = p.mealAllowancePaise + p.travelAllowancePaise;

  return {
    startedAt: start, endedAt: end, breakMinutes, payableMinutes: regularMinutes, overtimeMinutes, stayedLateMinutes,
    basePayPaise: basePay, overtimePayPaise: overtimePay, allowancesPaise: allowances, grossPaise: basePay + overtimePay + allowances,
  };
}

/** Pay for some minutes at the timesheet's effective rate (used for partial disputes). */
export function payForMinutes(t: { basePayPaise: number; overtimePayPaise: number; payableMinutes: number; overtimeMinutes: number }, minutes: number): number {
  const total = t.payableMinutes + t.overtimeMinutes;
  if (total === 0) return 0;
  return mulDivRound(t.basePayPaise + t.overtimePayPaise, Math.min(minutes, total), total);
}
