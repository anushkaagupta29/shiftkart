/** Calendar date (YYYY-MM-DD) in IST for a UTC instant. Times are stored in UTC and shown in IST. */
export function istDate(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** Whole years between a YYYY-MM-DD birth date and today's IST date. */
export function ageOn(dob: string, today: string): number {
  const [by, bm, bd] = dob.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = today.split('-').map(Number) as [number, number, number];
  return ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
}
