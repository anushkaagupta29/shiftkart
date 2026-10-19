import { lookupHash, maskPhone } from '@shiftkart/shared';
import type { Queryable } from '../db';

export interface SmsSender {
  send(toE164: string, body: string): Promise<void>;
}

/**
 * Mock SMS: writes to the dev_outbox table instead of sending anything.
 * A real provider (e.g. MSG91) will implement the same interface in Phase 5, sandbox first.
 */
export class MockSms implements SmsSender {
  constructor(private db: Queryable, private hashKey: string) {}
  async send(toE164: string, body: string): Promise<void> {
    await this.db.query(
      'INSERT INTO dev_outbox (channel, to_hash, to_masked, body) VALUES ($1, $2, $3, $4)',
      ['sms', lookupHash(toE164, this.hashKey), maskPhone(toE164), body],
    );
  }
}
