import { createHmac } from 'node:crypto';

// Rotating gate codes (WRK-05). The site secret never leaves the server. For each shift the
// supervisor's phone gets a shift key = HMAC(siteSecret, shiftId), so it can keep showing codes
// with no network (offline fallback). A leaked shift key is useless for any other shift or site.
export const QR_PERIOD_SEC = 30;

export const qrStep = (atMs: number) => Math.floor(atMs / 1000 / QR_PERIOD_SEC);

export function shiftKey(siteSecret: string, shiftId: string): Buffer {
  return createHmac('sha256', siteSecret).update(`shift:${shiftId}`).digest();
}

function mac(key: Buffer, step: number): Buffer {
  return createHmac('sha256', key).update(`step:${step}`).digest();
}

/** 6-digit code (typed by hand when a camera can't scan) for a step. */
export function gateCode(key: Buffer, step: number): string {
  return (mac(key, step).readUInt32BE(0) % 1_000_000).toString().padStart(6, '0');
}

/** Full QR payload: "sk1.<shiftId>.<step>.<code>". */
export function qrPayload(key: Buffer, shiftId: string, step: number): string {
  return `sk1.${shiftId}.${step}.${gateCode(key, step)}`;
}

export type QrCheck = { ok: true; step: number } | { ok: false; reason: 'malformed' | 'wrong_shift' | 'expired' | 'invalid' };

/**
 * Accepts a QR payload or a 6-digit code. Valid for the step at `atMs` ±1 (≤ 90 s), so a
 * screenshot from yesterday, or a code sent on WhatsApp a few minutes later, doesn't work.
 */
export function verifyGateCode(key: Buffer, shiftId: string, input: string, atMs: number): QrCheck {
  const now = qrStep(atMs);
  let code = input.trim();
  let claimedStep: number | null = null;
  if (code.startsWith('sk1.')) {
    const parts = code.split('.');
    if (parts.length !== 4) return { ok: false, reason: 'malformed' };
    if (parts[1] !== shiftId) return { ok: false, reason: 'wrong_shift' };
    claimedStep = Number(parts[2]);
    code = parts[3]!;
    if (!Number.isSafeInteger(claimedStep)) return { ok: false, reason: 'malformed' };
    if (Math.abs(claimedStep - now) > 1) return { ok: false, reason: 'expired' };
  }
  if (!/^\d{6}$/.test(code)) return { ok: false, reason: 'malformed' };
  const steps = claimedStep !== null ? [claimedStep] : [now, now - 1, now + 1];
  for (const s of steps) if (gateCode(key, s) === code) return { ok: true, step: s };
  return { ok: false, reason: claimedStep !== null ? 'invalid' : 'expired' };
}
