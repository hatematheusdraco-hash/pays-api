import pg from 'pg';
import { config } from './config.js';

// Keep numeric/decimal columns as strings — never let node-pg coerce money to
// a JS float. (pg type id 1700 = NUMERIC.)
pg.types.setTypeParser(1700, (v) => v);

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
  idleTimeoutMillis: 30_000,
  // Supabase requires TLS; it presents a cert the default CA bundle doesn't
  // always chain, so disable strict verification for the pooler connection.
  ssl: config.databaseUrl.includes('supabase.')
    ? { rejectUnauthorized: false }
    : undefined,
});

export type Sql = pg.Pool | pg.PoolClient;

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
  client: Sql = pool,
): Promise<T[]> {
  const res = await client.query<T>(sql, params);
  return res.rows;
}

export async function one<T extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
  client: Sql = pool,
): Promise<T | null> {
  const rows = await query<T>(sql, params, client);
  return rows[0] ?? null;
}

/** Run `fn` inside a transaction; commits on success, rolls back on throw. */
export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function ping(): Promise<boolean> {
  const rows = await query<{ ok: number }>('select 1 as ok');
  return rows[0]?.ok === 1;
}

export async function closePool(): Promise<void> {
  await pool.end();
}
