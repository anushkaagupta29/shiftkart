import { loadConfig } from './config';
import { createPool } from './db';
import { buildApp } from './app';
import { startJobs } from './jobs';
import { MockSms } from './adapters/sms';
import { MockPayouts } from './adapters/payouts';
import { sendersFromEnv } from './adapters/messaging';

const config = loadConfig();
const db = createPool(config.databaseUrl);
if (config.env === 'production') {
  // The API must run as the least-privilege role, never as the owner of the tables (migration 007).
  const own = await db.query(`SELECT tableowner = current_user AS owner FROM pg_tables WHERE tablename = 'audit_log'`);
  if (own.rows[0]?.owner) throw new Error('Refusing to start: the API is connected as the table owner. Use the shiftkart_app role.');
}
const app = await buildApp(config, db);
await app.listen({ port: config.port, host: '127.0.0.1' });
const stopJobs = startJobs({ db, sms: new MockSms(db, config.hashKey), payouts: new MockPayouts(db), dataKey: config.dataKey, senders: sendersFromEnv(db, config.hashKey) }, app.log);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    stopJobs();
    await app.close();
    await db.end();
    process.exit(0);
  });
}
