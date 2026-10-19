import { loadRootEnv, requireEnv } from './env';
import { migrate, resetDatabase } from './migrate';

loadRootEnv();
const cmd = process.argv[2];
const urls = [requireEnv('DATABASE_URL'), process.env.DATABASE_URL_TEST].filter(Boolean) as string[];

for (const url of urls) {
  const name = new URL(url).pathname.slice(1);
  if (cmd === 'reset') {
    await resetDatabase(url);
    console.log(`[${name}] reset`);
  }
  if (cmd === 'migrate' || cmd === 'reset') {
    const applied = await migrate(url, (m) => console.log(`[${name}] ${m}`));
    if (!applied.length) console.log(`[${name}] up to date`);
  }
}
