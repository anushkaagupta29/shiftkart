// India-only phone numbers in E.164 (+91 followed by 10 digits starting 6-9).
const INDIAN_MOBILE = /^[6-9]\d{9}$/;

export function normalizeIndianPhone(input: string): string | null {
  const digits = input.replace(/[\s\-()]/g, '');
  let local: string | null = null;
  if (/^\+91\d{10}$/.test(digits)) local = digits.slice(3);
  else if (/^91\d{10}$/.test(digits)) local = digits.slice(2);
  else if (/^0\d{10}$/.test(digits)) local = digits.slice(1);
  else if (/^\d{10}$/.test(digits)) local = digits;
  if (!local || !INDIAN_MOBILE.test(local)) return null;
  return `+91${local}`;
}
