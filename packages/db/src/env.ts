import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/** Loads the repo-root .env once (no dependency; Node >= 20.12). Existing env vars win. */
export function loadRootEnv(): void {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const file = resolve(root, '.env');
  if (existsSync(file)) process.loadEnvFile(file);
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}. Run \`npm run setup\` first.`);
  return v;
}
