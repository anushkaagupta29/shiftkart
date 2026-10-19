import type { Queryable } from '../db';
import { mockEmbedding } from './mock-face';

// Identity verification via DigiLocker or a licensed KYC provider. We receive a reference id,
// name, date of birth and photo; we keep the reference (hashed), name, birth year and a face
// embedding, and never store any Aadhaar number or document image (SPEC §6.1, D-018).

export type KycResult = {
  providerRef: string;
  legalName: string;
  dob: string; // YYYY-MM-DD, used once to compute age, never stored
  faceEmbedding: number[];
};

export interface KycProvider {
  start(userId: string): Promise<{ sessionId: string; redirectPath: string }>;
  /** null = the person hasn't finished on the provider's side yet. */
  fetchResult(sessionId: string, userId: string): Promise<KycResult | null>;
}

export type MockPersona = { personId: string; name: string; dob: string; faceId?: string };

/** Mock DigiLocker. The dev-only consent screen stores a persona against the session. */
export class MockKyc implements KycProvider {
  constructor(private db: Queryable) {}

  async start(userId: string) {
    const r = await this.db.query('INSERT INTO mock_kyc_sessions (user_id) VALUES ($1) RETURNING id', [userId]);
    return { sessionId: r.rows[0].id as string, redirectPath: `/mock/digilocker/${r.rows[0].id}` };
  }

  async fetchResult(sessionId: string, userId: string): Promise<KycResult | null> {
    const r = await this.db.query(
      `UPDATE mock_kyc_sessions SET consumed_at = now()
        WHERE id = $1 AND user_id = $2 AND persona IS NOT NULL AND consumed_at IS NULL RETURNING persona`,
      [sessionId, userId],
    );
    const p = r.rows[0]?.persona as MockPersona | undefined;
    if (!p) return null;
    return { providerRef: `mockdl:${p.personId}`, legalName: p.name, dob: p.dob, faceEmbedding: mockEmbedding(p.faceId ?? p.personId) };
  }
}
