import type { Queryable } from '../db';

export type GstinLookup = { found: true; legalName: string; status: string; stateCode: string } | { found: false };

export interface GstnProvider {
  lookup(gstin: string): Promise<GstinLookup>;
}

/** Mock GSTN: GSTINs in mock_gstn_registry return that legal name; any other well-formed GSTIN is "not found". */
export class MockGstn implements GstnProvider {
  constructor(private db: Queryable) {}
  async lookup(gstin: string): Promise<GstinLookup> {
    const r = await this.db.query('SELECT legal_name, status FROM mock_gstn_registry WHERE gstin = $1', [gstin]);
    if (!r.rowCount) return { found: false };
    return { found: true, legalName: r.rows[0].legal_name, status: r.rows[0].status, stateCode: gstin.slice(0, 2) };
  }
}

/** GSTIN characters 3–12 are the PAN. */
export const panFromGstin = (gstin: string) => gstin.slice(2, 12);
