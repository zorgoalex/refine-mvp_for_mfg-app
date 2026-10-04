import { randomBytes } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Explicit opt-in. Only a randomly named disposable DB is mutated; the migration applied is a file written by this
// test into a temp dir. Requires CREATEDB rights on the test container.
const enabled = process.env.ERP_MIGRATION_PROBE_INTEGRATION === 'true';
const container = process.env.PG_CONTAINER || 'erp_test-postgresdb-1';
const db = `e2e_migration_lock_${randomBytes(10).toString('hex')}`;
const script = resolve(__dirname, 'apply-migrations.sh');
const FILE = '900_lock_probe.sql';

const PSQL = 'exec psql -U "$POSTGRES_USER" -d "$1" -X -qAt -v ON_ERROR_STOP=1';
function sql(query: string, database = db) {
  return execFileSync('docker', ['exec', '-i', container, 'sh', '-lc', PSQL, 'lock-test', database],
    { input: query, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 }).trim();
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!enabled)('apply --lock-timeout against a busy table on PostgreSQL', () => {
  let created = false;
  let dir = '';
  const apply = (extra: string[]) => spawnSync('bash',
    [script, 'apply', '--yes', '--container', container, '--db', db, '--dir', dir, ...extra],
    { encoding: 'utf8', timeout: 60000 });

  beforeAll(() => {
    sql(`CREATE DATABASE ${db} TEMPLATE template0;`, 'postgres');
    created = true;
    // `users` is what the runner's prelude reads and what the 1C migrations reference.
    sql('CREATE TABLE users (user_id bigint PRIMARY KEY); INSERT INTO users VALUES (1);');
    dir = mkdtempSync(join(tmpdir(), 'erp-lock-migration-'));
    // Same shape as the 1C migrations: one transaction, a new table first, then an FK that locks a busy table.
    writeFileSync(join(dir, FILE), [
      'BEGIN;',
      'CREATE TABLE lock_probe_child (id bigint PRIMARY KEY, parent_id bigint);',
      'ALTER TABLE lock_probe_child ADD CONSTRAINT lock_probe_child_parent_fk FOREIGN KEY (parent_id) REFERENCES users(user_id);',
      'COMMIT;', '',
    ].join('\n'));
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    if (created) sql(`DROP DATABASE IF EXISTS ${db} WITH (FORCE);`, 'postgres');
  });

  it('fails fast, rolls the migration back and leaves the ledger untouched; a retry then applies it', async () => {
    const holder = spawn('docker', ['exec', '-i', container, 'sh', '-lc', PSQL, 'lock-holder', db],
      { stdio: ['pipe', 'ignore', 'ignore'] });
    // A writer inside a long transaction: readers pass, an FK (SHARE ROW EXCLUSIVE) has to wait.
    holder.stdin.write('BEGIN; LOCK TABLE users IN ROW EXCLUSIVE MODE; SELECT pg_sleep(20);\n');
    try {
      let held = false;
      for (let i = 0; i < 40 && !held; i += 1) {
        held = sql("SELECT EXISTS (SELECT 1 FROM pg_locks l JOIN pg_class c ON c.oid = l.relation WHERE c.relname = 'users' AND l.mode = 'RowExclusiveLock' AND l.granted);") === 't';
        if (!held) await sleep(250);
      }
      expect(held).toBe(true);

      const startedAt = Date.now();
      const blocked = apply(['--lock-timeout', '1s']);
      expect(blocked.status).not.toBe(0);
      expect(Date.now() - startedAt).toBeLessThan(15000);
      expect(`${blocked.stdout}${blocked.stderr}`).toMatch(/lock timeout/i);
      expect(`${blocked.stdout}${blocked.stderr}`).toContain(`FAILED on ${FILE}`);
      expect(sql("SELECT to_regclass('public.lock_probe_child') IS NULL;")).toBe('t');
      expect(sql(`SELECT count(*) FROM schema_migrations WHERE filename = '${FILE}';`)).toBe('0');
      // Nothing of the migration is left waiting: writers queued behind it are free again.
      expect(sql("SELECT count(*) FROM pg_locks WHERE NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database());")).toBe('0');

      const slow = join(dir, '899_slow_probe.sql');
      writeFileSync(slow, 'BEGIN;\nCREATE TABLE slow_probe (id bigint);\nSELECT pg_sleep(10);\nCOMMIT;\n');
      const timedOut = apply(['--to', '899', '--statement-timeout', '1s']);
      rmSync(slow);
      expect(`${timedOut.stdout}${timedOut.stderr}`).toMatch(/statement timeout/i);
      expect(sql("SELECT to_regclass('public.slow_probe') IS NULL;")).toBe('t');
      expect(sql("SELECT count(*) FROM schema_migrations;")).toBe('0');
    } finally {
      sql("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND application_name = 'psql' AND pid <> pg_backend_pid() AND state <> 'idle';");
      holder.stdin.end();
      holder.kill();
    }

    const retried = apply(['--lock-timeout', '1s']);
    expect(`${retried.stdout}${retried.stderr}`).toContain('All pending migrations applied.');
    expect(retried.status).toBe(0);
    expect(sql("SELECT to_regclass('public.lock_probe_child') IS NOT NULL;")).toBe('t');
    expect(sql(`SELECT count(*) FROM schema_migrations WHERE filename = '${FILE}';`)).toBe('1');
  }, 90000);
});
