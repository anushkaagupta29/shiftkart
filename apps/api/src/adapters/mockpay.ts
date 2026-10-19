import { createHmac, randomBytes } from 'node:crypto';
import { safeEqual } from '@shiftkart/shared';

// Mock escrow/payment provider. It mimics the shape of real providers: create an order,
// the payer completes checkout elsewhere, and the provider tells us via a signed webhook.
// A real provider (with an RBI-authorised escrow/nodal setup, LEGAL L-15) replaces this.

export const MOCKPAY_SIG_HEADER = 'x-mockpay-signature';
export const SIGNATURE_TOLERANCE_SEC = 300;

export function newProviderRef(): string {
  return `mp_order_${randomBytes(10).toString('hex')}`;
}

export function signWebhook(secret: string, rawBody: string, timestampSec = Math.floor(Date.now() / 1000)): string {
  const sig = createHmac('sha256', secret).update(`${timestampSec}.${rawBody}`).digest('hex');
  return `t=${timestampSec},v1=${sig}`;
}

/** SYS-04: HMAC signature over timestamp + raw body, with a replay window. */
export function verifyWebhookSignature(secret: string, rawBody: string, header: string | undefined, nowSec = Math.floor(Date.now() / 1000)): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=') as [string, string]));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !parts.v1) return false;
  if (Math.abs(nowSec - t) > SIGNATURE_TOLERANCE_SEC) return false;
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  return safeEqual(expected, parts.v1);
}

export type MockpayEvent = {
  id: string;
  type: 'payment.captured' | 'payment.failed' | 'payment.chargeback' | 'payout.reversed';
  data: { orderRef: string; amountPaise: number };
};
