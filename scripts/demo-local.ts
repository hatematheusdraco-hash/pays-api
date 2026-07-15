/**
 * Fully self-contained demo: boots a throwaway *real* PostgreSQL (embedded
 * binary, no Docker), applies the migrations, and runs the end-to-end demo
 * against it — then tears everything down. Proves the whole stack works with
 * zero external setup. Run: `npm run demo:local`.
 *
 * Env must be set BEFORE importing anything that reads config, so the app
 * modules are pulled in via dynamic import() after DATABASE_URL is assigned.
 */
import EmbeddedPostgres from 'embedded-postgres';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 54329;

async function main() {
  const dataDir = await mkdtemp(join(tmpdir(), 'pays-pg-'));
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres',
    port: PORT,
    persistent: false, // wipe on stop
  });

  console.log('▶ starting embedded PostgreSQL…');
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('pays');
  process.env.DATABASE_URL = `postgresql://postgres:postgres@localhost:${PORT}/pays`;
  console.log('  postgres up on', process.env.DATABASE_URL);

  let ok = false;
  try {
    const { runMigrations } = await import('./migrate.js');
    await runMigrations();

    const { runDemo } = await import('./demo.js');
    ok = await runDemo();

    const { closePool } = await import('../src/db.js');
    await closePool();
  } finally {
    console.log('▶ stopping embedded PostgreSQL…');
    await pg.stop();
    await rm(dataDir, { recursive: true, force: true });
  }

  process.exit(ok ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
