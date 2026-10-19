import { loadConfig } from './config';
import { createPool } from './db';
import { buildApp } from './app';
import { startJobs } from './jobs';
import { MockSms } from './adapters/sms';

const config = loadConfig();
const db = createPool(config.databaseUrl);
const app = await buildApp(config, db);
await app.listen({ port: config.port, host: '127.0.0.1' });
const stopJobs = startJobs(db, new MockSms(db, config.hashKey), config.dataKey, app.log);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    stopJobs();
    await app.close();
    await db.end();
    process.exit(0);
  });
}
