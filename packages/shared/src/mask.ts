/** "+919876543210" -> "+91 ******3210" */
export function maskPhone(e164: string): string {
  return `${e164.slice(0, 3)} ******${e164.slice(-4)}`;
}

/** Removes anything that looks like an Indian mobile number, email or OTP-ish secret from free text. */
export function redactPII(text: string): string {
  return text
    .replace(/(\+?91[\s-]?)?[6-9]\d{4}[\s-]?\d{5}/g, '[phone]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]');
}
