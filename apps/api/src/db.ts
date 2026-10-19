import pg from 'pg';

// bigint (int8) -> number, but only when it is exactly representable. Money stays integer paise.
pg.types.setTypeParser(20, (v) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new RangeError(`int8 value ${v} exceeds safe integer range`);
  return n;
});

export type Db = pg.Pool;
export type Tx = pg.PoolClient;
export type Queryable = pg.Pool | pg.PoolClient;

export function createPool(connectionString: string): Db {
  return new pg.Pool({ connectionString, max: 20 });
}

export async function withTx<T>(db: Db, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
