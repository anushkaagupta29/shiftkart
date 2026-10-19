import pg from 'pg';
import { loadRootEnv, requireEnv } from '@shiftkart/db';

/**
 * Every E2E login comes from 127.0.0.1, which quickly hits the real per-network OTP limit
 * (10 codes an hour, abuse case ACC-02). Clear those counters in the LOCAL database only.
 */
export default async function globalSetup() {
  loadRootEnv();
  const url = requireEnv('DATABASE_URL');
  if (!['localhost', '127.0.0.1'].includes(new URL(url).hostname)) throw new Error('E2E only runs against a local database');
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  await db.query(`DELETE FROM otp_requests WHERE ip IN ('127.0.0.1', '::1', '::ffff:127.0.0.1')`);
  await db.end();
}
