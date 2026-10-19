import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../migrations');

/** Applies pending SQL migrations in filename order, each in its own transaction. */
export async function migrate(databaseUrl: string, log: (m: string) => void = console.log): Promise<string[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock(727274)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(file)) continue;
      const sql = readFileSync(resolve(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
        log(`applied ${file}`);
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${(e as Error).message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)').catch(() => {});
    await client.end();
  }
  return applied;
}

/** Drops everything in the public schema. Refuses anything that isn't a local database. */
export async function resetDatabase(databaseUrl: string): Promise<void> {
  const host = new URL(databaseUrl).hostname;
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    throw new Error(`Refusing to reset non-local database host "${host}"`);
  }
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  } finally {
    await client.end();
  }
}
