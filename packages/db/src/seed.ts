// Idempotent local seed. Creates staff accounts (one per role), sample workers and a sample business.
// All data is fake. Phone numbers are never messaged: SMS is mocked into the dev_outbox table.
import pg from 'pg';
import { encrypt, hashPassword, lookupHash, newTotpSecret } from '@shiftkart/shared';
import { loadRootEnv, requireEnv } from './env';
import { DEFAULT_POLICY } from './policy-defaults';

loadRootEnv();
const DATA_KEY = requireEnv('DATA_KEY');
const HASH_KEY = requireEnv('HASH_KEY');
const STAFF_PASSWORD = requireEnv('SEED_STAFF_PASSWORD');

export const SEED_STAFF = [
  { email: 'super@shiftkart.local', name: 'Super Admin', roles: ['super_admin'] },
  { email: 'support@shiftkart.local', name: 'Support Agent', roles: ['ops_support'] },
  { email: 'verifier@shiftkart.local', name: 'Verifier', roles: ['ops_verifier'] },
  { email: 'disputes@shiftkart.local', name: 'Disputes Officer', roles: ['ops_disputes'] },
  { email: 'safety@shiftkart.local', name: 'Safety Officer', roles: ['ops_safety'] },
  { email: 'finance@shiftkart.local', name: 'Finance', roles: ['finance'] },
  { email: 'compliance@shiftkart.local', name: 'Compliance', roles: ['compliance'] },
];

// Fake numbers in the 90000 0000x range.
export const SEED_USERS = [
  { phone: '+919000000001', kind: 'worker', lang: 'hi' },
  { phone: '+919000000002', kind: 'worker', lang: 'kn' },
  { phone: '+919000000003', kind: 'worker', lang: 'en' },
  { phone: '+919000000101', kind: 'business', lang: 'en' }, // owner of the sample business
  { phone: '+919000000102', kind: 'business', lang: 'hi' }, // supervisor at the sample business
] as const;

const client = new pg.Client({ connectionString: requireEnv('DATABASE_URL') });
await client.connect();
try {
  await client.query('BEGIN');

  for (const s of SEED_STAFF) {
    const exists = await client.query('SELECT 1 FROM staff_users WHERE email = $1', [s.email]);
    if (exists.rowCount) continue;
    await client.query(
      `INSERT INTO staff_users (email, name, password_hash, totp_secret_enc, roles) VALUES ($1, $2, $3, $4, $5)`,
      [s.email, s.name, await hashPassword(STAFF_PASSWORD), encrypt(newTotpSecret(), DATA_KEY), s.roles],
    );
  }

  const ids: Record<string, string> = {};
  for (const u of SEED_USERS) {
    const hash = lookupHash(u.phone, HASH_KEY);
    const r = await client.query(
      `INSERT INTO users (phone_enc, phone_hash, phone_last4, kind, preferred_lang) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (phone_hash) DO UPDATE SET phone_hash = EXCLUDED.phone_hash RETURNING id`,
      [encrypt(u.phone, DATA_KEY), hash, u.phone.slice(-4), u.kind, u.lang],
    );
    ids[u.phone] = r.rows[0].id;
    await client.query(
      `INSERT INTO consents (user_id, purpose, version, lang)
       SELECT $1, 'account', 'draft-0', $2 WHERE NOT EXISTS (SELECT 1 FROM consents WHERE user_id = $1)`,
      [r.rows[0].id, u.lang],
    );
  }

  const owner = ids['+919000000101']!;
  const supervisor = ids['+919000000102']!;
  let biz = await client.query(`SELECT id FROM businesses WHERE legal_name = 'Demo Warehouse Pvt Ltd (SAMPLE)'`);
  if (!biz.rowCount) {
    biz = await client.query(
      `INSERT INTO businesses (legal_name, trade_name, created_by) VALUES ('Demo Warehouse Pvt Ltd (SAMPLE)', 'Demo Warehouse', $1) RETURNING id`,
      [owner],
    );
    const bizId = biz.rows[0].id;
    await client.query(`INSERT INTO business_members (business_id, user_id, role) VALUES ($1, $2, 'owner')`, [bizId, owner]);
    await client.query(`INSERT INTO business_members (business_id, user_id, role, added_by) VALUES ($1, $2, 'supervisor', $3)`, [bizId, supervisor, owner]);
  }

  // SAMPLE minimum wage rates, NOT real Karnataka figures (LEGAL_CHECKLIST L-04). Amounts in paise per day.
  const sampleRates: [string, string, number, number][] = [
    ['A', 'unskilled', 60000, 4000], ['A', 'semi_skilled', 66000, 4000], ['A', 'skilled', 72000, 4000],
    ['B', 'unskilled', 56000, 4000], ['B', 'semi_skilled', 62000, 4000], ['B', 'skilled', 68000, 4000],
  ];
  for (const [zone, cat, basic, vda] of sampleRates) {
    await client.query(
      `INSERT INTO min_wage_rates (state_code, wage_category, zone, basic_paise_per_day, vda_paise_per_day, effective_from, source_ref, status)
       SELECT 'KA', $1, $2, $3, $4, '2026-01-01', 'SAMPLE seed data, not a real notification', 'active'
       WHERE NOT EXISTS (SELECT 1 FROM min_wage_rates WHERE state_code = 'KA' AND wage_category = $1 AND zone = $2)`,
      [cat, zone, basic, vda],
    );
  }

  // Mock GSTN registry. Any other well-formed GSTIN looks "not found" (and goes to two-person review).
  await client.query(
    `INSERT INTO mock_gstn_registry (gstin, legal_name) VALUES
       ('29ABCDE1234F1Z5', 'Demo Warehouse Pvt Ltd (SAMPLE)'),
       ('29PQRST5678K1Z2', 'Namma Retail Stores LLP'),
       ('29LMNOP4321Q1Z9', 'Unrelated Holdings Pvt Ltd')
     ON CONFLICT DO NOTHING`,
  );

  // The sample business gets a verified site in Bengaluru so you can post shifts straight away.
  const demo = (await client.query(`SELECT id, verification_status FROM businesses WHERE legal_name = 'Demo Warehouse Pvt Ltd (SAMPLE)'`)).rows[0];
  if (demo && demo.verification_status === 'draft') {
    await client.query(
      `INSERT INTO sites (business_id, name, address, city_code, state_code, wage_zone, location, status)
       VALUES ($1, 'Whitefield Warehouse', 'Plot 12, EPIP Zone, Whitefield, Bengaluru 560066 (SAMPLE)', 'BLR', 'KA', 'A',
               ST_MakePoint(77.7310, 12.9790)::geography, 'active')`,
      [demo.id],
    );
    await client.query(
      `UPDATE businesses SET verification_status = 'verified', verified_at = now() - interval '60 days', risk_tier = 'standard',
              gstin = '29ABCDE1234F1Z5', gst_legal_name = legal_name, pan_last4 = '234F', signatory_name = 'Asha Rao (SAMPLE)',
              submitted_at = now() - interval '61 days', decision_reason = 'Seed data'
        WHERE id = $1`,
      [demo.id],
    );
  }

  for (const [key, value] of Object.entries(DEFAULT_POLICY)) {
    await client.query(
      `INSERT INTO policy_config (key, value, effective_from, reason)
       SELECT $1, $2::jsonb, '2026-01-01T00:00:00Z', 'Seed default (placeholder, see DECISIONS D-011)'
       WHERE NOT EXISTS (SELECT 1 FROM policy_config WHERE key = $1 AND scope = 'global')`,
      [key, JSON.stringify(value)],
    );
  }

  await client.query('COMMIT');
  console.log(`Seeded ${SEED_STAFF.length} staff, ${SEED_USERS.length} users, 1 sample business, ${Object.keys(DEFAULT_POLICY).length} policy values.`);
  console.log('Staff password: SEED_STAFF_PASSWORD in .env. 2FA code: npm run totp -- <email>');
} catch (e) {
  await client.query('ROLLBACK');
  throw e;
} finally {
  await client.end();
}
