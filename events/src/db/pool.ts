import pg from 'pg';
import { MIGRATION } from './migration.ts';

/** What repositories need: a pool, or a client inside a transaction. */
export type Queryable = Pick<pg.PoolClient, 'query'>;

export function createPool(databaseUrl: string): pg.Pool {
  return new pg.Pool({ connectionString: databaseUrl, max: 10, connectionTimeoutMillis: 3000 });
}

const MIGRATION_LOCK = 727002; // the reports service uses 727001 on its own database

/** Idempotent; the advisory lock makes replicas starting together safe. */
export async function migrate(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await client.query(MIGRATION);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => {});
    client.release();
  }
}

/** Runs fn in a transaction: COMMIT if it resolves, ROLLBACK (and rethrow) if it throws. */
export async function withTransaction<T>(pool: pg.Pool, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  const client = await pool.connect();
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

/** Liveness of the database for /healthcheck; never hangs longer than timeoutMs. */
export async function ping(pool: pg.Pool, timeoutMs = 2000): Promise<void> {
  await Promise.race([
    pool.query('SELECT 1'),
    new Promise((_, reject) => setTimeout(() => reject(new Error('database ping timeout')), timeoutMs).unref()),
  ]);
}
