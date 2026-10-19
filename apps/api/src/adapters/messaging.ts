import { lookupHash, maskPhone } from '@shiftkart/shared';
import type { Queryable } from '../db';

// SMS and WhatsApp senders. Mocks write to dev_outbox. The MSG91 (SMS) and Gupshup (WhatsApp)
// adapters are written to those providers' public APIs but stay switched off: they refuse to run
// unless ALLOW_REAL_MESSAGES=true, and real use needs DLT-registered templates and a verified
// WhatsApp Business account (both need a registered company; LEGAL L-29, L-32).

export type SendResult = { ok: true; providerRef: string } | { ok: false; retryable: boolean; error: string };

export interface MessageSender {
  readonly channel: 'sms' | 'whatsapp';
  readonly provider: string;
  send(toE164: string, body: string, meta: { template: string; dltId?: string }): Promise<SendResult>;
}

export class MockSender implements MessageSender {
  readonly provider = 'mock';
  constructor(readonly channel: 'sms' | 'whatsapp', private db: Queryable, private hashKey: string) {}
  async send(toE164: string, body: string): Promise<SendResult> {
    const r = await this.db.query(
      'INSERT INTO dev_outbox (channel, to_hash, to_masked, body) VALUES ($1, $2, $3, $4) RETURNING id',
      [this.channel, lookupHash(toE164, this.hashKey), maskPhone(toE164), body],
    );
    return { ok: true, providerRef: `mock_${r.rows[0].id}` };
  }
}

type Fetch = typeof fetch;

function assertRealAllowed(name: string) {
  if (process.env.ALLOW_REAL_MESSAGES !== 'true') {
    throw new Error(`${name} is configured but ALLOW_REAL_MESSAGES is not "true". Real messages are off until the owner approves going live.`);
  }
}

/** MSG91 Flow API (SMS). Each template maps to a DLT-approved flow id via MSG91_FLOW_<TEMPLATE>. */
export class Msg91Sms implements MessageSender {
  readonly channel = 'sms' as const;
  readonly provider = 'msg91';
  constructor(private authKey: string, private fetchImpl: Fetch = fetch) { assertRealAllowed('MSG91'); }
  async send(toE164: string, body: string, meta: { template: string }): Promise<SendResult> {
    const flowId = process.env[`MSG91_FLOW_${meta.template.toUpperCase()}`];
    if (!flowId) return { ok: false, retryable: false, error: `no DLT flow configured for ${meta.template}` };
    try {
      const res = await this.fetchImpl('https://control.msg91.com/api/v5/flow/', {
        method: 'POST',
        headers: { authkey: this.authKey, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ template_id: flowId, short_url: '0', recipients: [{ mobiles: toE164.replace('+', ''), body }] }),
      });
      const data = (await res.json().catch(() => ({}))) as { type?: string; message?: string; request_id?: string };
      if (res.ok && data.type === 'success') return { ok: true, providerRef: data.request_id ?? data.message ?? 'msg91' };
      return { ok: false, retryable: res.status >= 500, error: data.message ?? `HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, retryable: true, error: (e as Error).message };
    }
  }
}

/** Gupshup WhatsApp template messages. Needs an approved template per message (WHATSAPP_TPL_<TEMPLATE>). */
export class GupshupWhatsApp implements MessageSender {
  readonly channel = 'whatsapp' as const;
  readonly provider = 'gupshup';
  constructor(private apiKey: string, private source: string, private appName: string, private fetchImpl: Fetch = fetch) { assertRealAllowed('Gupshup'); }
  async send(toE164: string, body: string, meta: { template: string }): Promise<SendResult> {
    const tplId = process.env[`WHATSAPP_TPL_${meta.template.toUpperCase()}`];
    if (!tplId) return { ok: false, retryable: false, error: `no approved WhatsApp template for ${meta.template}` };
    try {
      const form = new URLSearchParams({
        channel: 'whatsapp', source: this.source, destination: toE164.replace('+', ''), 'src.name': this.appName,
        template: JSON.stringify({ id: tplId, params: [body] }),
      });
      const res = await this.fetchImpl('https://api.gupshup.io/wa/api/v1/template/msg', {
        method: 'POST', headers: { apikey: this.apiKey, 'content-type': 'application/x-www-form-urlencoded' }, body: form,
      });
      const data = (await res.json().catch(() => ({}))) as { status?: string; messageId?: string; message?: string };
      if (res.ok && data.status === 'submitted') return { ok: true, providerRef: data.messageId ?? 'gupshup' };
      return { ok: false, retryable: res.status >= 500, error: data.message ?? `HTTP ${res.status}` };
    } catch (e) {
      return { ok: false, retryable: true, error: (e as Error).message };
    }
  }
}

export function sendersFromEnv(db: Queryable, hashKey: string): { sms: MessageSender; whatsapp: MessageSender } {
  const sms = process.env.SMS_PROVIDER === 'msg91' && process.env.MSG91_AUTH_KEY ? new Msg91Sms(process.env.MSG91_AUTH_KEY) : new MockSender('sms', db, hashKey);
  const whatsapp = process.env.WHATSAPP_PROVIDER === 'gupshup' && process.env.GUPSHUP_API_KEY
    ? new GupshupWhatsApp(process.env.GUPSHUP_API_KEY, process.env.GUPSHUP_SOURCE ?? '', process.env.GUPSHUP_APP ?? '')
    : new MockSender('whatsapp', db, hashKey);
  return { sms, whatsapp };
}
