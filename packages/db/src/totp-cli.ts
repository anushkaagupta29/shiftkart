// Local-dev helper: prints the current 2FA code for a seeded staff account,
// so you don't need an authenticator app on your laptop. Refuses to run in production.
import pg from 'pg';
import { decrypt, totp } from '@shiftkart/shared';
import { loadRootEnv, requireEnv } from './env';

loadRootEnv();
if (process.env.NODE_ENV === 'production') throw new Error('totp helper is disabled in production');
const email = process.argv[2];
if (!email) {
  console.error('usage: npm run totp -- <staff email>');
  process.exit(1);
}
const client = new pg.Client({ connectionString: requireEnv('DATABASE_URL') });
await client.connect();
const r = await client.query('SELECT totp_secret_enc FROM staff_users WHERE email = $1', [email]);
await client.end();
if (!r.rowCount) {
  console.error(`no staff user ${email}`);
  process.exit(1);
}
const secret = decrypt(r.rows[0].totp_secret_enc, requireEnv('DATA_KEY'));
const secondsLeft = 30 - (Math.floor(Date.now() / 1000) % 30);
console.log(`${totp(secret)}  (valid ~${secondsLeft}s)`);
