import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { closePool, pool } from '../src/db.js';

/**
 * Minimal migration runner: applies every .sql file in supabase/migrations in
 * lexical order, tracking applied files in a _migrations table so re-runs are
 * idempotent. Fine for MVP; swap for Supabase CLI migrations in production.
 */
// Resolved from the working directory so it works under tsx (project root) and
// in the Docker image (WORKDIR /app), where supabase/ sits next to dist/.
const dir = join(process.cwd(), 'supabase', 'migrations');

export async function runMigrations() {
  await pool.query(
    `create table if not exists _migrations (
       name text primary key,
       applied_at timestamptz not null default now()
     )`,
  );

  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    const already = await pool.query('select 1 from _migrations where name = $1', [file]);
    if (already.rowCount) {
      console.log(`· skip   ${file}`);
      continue;
    }
    const sql = await readFile(join(dir, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('insert into _migrations (name) values ($1)', [file]);
      await client.query('COMMIT');
      console.log(`✓ apply  ${file}`);
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`✗ failed ${file}`);
      throw err;
    } finally {
      client.release();
    }
  }
}

// Run directly (npm run migrate) — but importable as runMigrations() too.
if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations()
    .then(() => closePool())
    .then(() => console.log('migrations complete'))
    .catch(async (err) => {
      console.error(err);
      await closePool();
      process.exit(1);
    });
}
