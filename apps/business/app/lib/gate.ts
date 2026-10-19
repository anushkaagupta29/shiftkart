'use client';

// Same derivation as apps/api/src/domain/qr.ts, computed on the phone with WebCrypto so the gate
// screen keeps working with no network once the shift key is loaded.
export const stepAt = (ms: number, period: number) => Math.floor(ms / 1000 / period);

export async function gateCodeFor(keyB64: string, step: number): Promise<string> {
  const raw = Uint8Array.from(atob(keyB64), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`step:${step}`));
  return (new DataView(sig).getUint32(0) % 1_000_000).toString().padStart(6, '0');
}
