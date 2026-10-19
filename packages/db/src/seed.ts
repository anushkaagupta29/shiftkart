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
