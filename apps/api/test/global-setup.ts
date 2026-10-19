import { loadRootEnv, migrate, requireEnv, resetDatabase } from '@shiftkart/db';

export default async function setup() {
  loadRootEnv();
  const url = requireEnv('DATABASE_URL_TEST');
  await resetDatabase(url);
  await migrate(url, () => {});
}
