import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const databaseUrl =
  process.env.CRM_SYNC_INTEGRATION_DATABASE_URL ?? process.env.TEST_DATABASE_URL;
const container = process.env.CRM_SYNC_PROBE_CONTAINER ?? 'erp_test-postgresdb-1';
const runner = fileURLToPath(new URL('../../../ops/apply-migrations.sh', import.meta.url));
const migrationDir = dirname(fileURLToPath(import.meta.url));
const dockerAvailable =
  spawnSync('docker', ['inspect', container], { stdio: 'ignore' }).status === 0;
const describeIntegration = databaseUrl && dockerAvailable ? describe : describe.skip;
const databaseName = `bitrix_probe_${randomUUID().replaceAll('-', '_')}`;

interface RunnerResult {
  status: number | null;
  output: string;
}

function databaseConnectionUrl(name: string): string {
  const url = new URL(databaseUrl!);
  url.pathname = `/${name}`;
  return url.toString();
}

function migrationOnlyDirectory(filename: string): string {
  const directory = mkdtempSync(join(tmpdir(), 'erp-bitrix-migration-'));
  copyFileSync(join(migrationDir, filename), join(directory, filename));
  return directory;
}

function runApply(directory: string): RunnerResult {
  const result = spawnSync(
    'bash',
    [
      runner,
      'apply',
      '--yes',
      '--container',
      container,
      '--db',
      databaseName,
      '--dir',
      directory,
    ],
    { encoding: 'utf8' },
  );
  return {
    status: result.status,
    output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
  };
}

describeIntegration('Bitrix24 migration runner end-state guards', () => {
  let adminPool: Pool;
  let pool: Pool;
  const temporaryDirectories: string[] = [];

  beforeAll(async () => {
    adminPool = new Pool({ connectionString: databaseUrl, max: 1 });
    await adminPool.query(`CREATE DATABASE "${databaseName}"`);
    pool = new Pool({ connectionString: databaseConnectionUrl(databaseName), max: 2 });
    await pool.query(`
      CREATE TABLE users (
        user_id BIGINT PRIMARY KEY
      );
      CREATE TABLE clients (
        client_id BIGINT PRIMARY KEY,
        client_name TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE client_phones (
        phone_id BIGINT PRIMARY KEY,
        client_id BIGINT NOT NULL REFERENCES clients(client_id),
        phone_number TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE orders (
        order_id BIGINT PRIMARY KEY,
        client_id BIGINT NOT NULL REFERENCES clients(client_id)
      );
      CREATE TABLE payments (
        payment_id BIGINT PRIMARY KEY,
        order_id BIGINT NOT NULL REFERENCES orders(order_id)
      );
    `);
    await pool.query(
      readFileSync(join(migrationDir, '025_twenty_crm_sync.sql'), 'utf8'),
    );
  }, 60_000);

  afterAll(async () => {
    for (const directory of temporaryDirectories) {
      rmSync(directory, { recursive: true, force: true });
    }
    await pool?.end();
    if (adminPool) {
      await adminPool.query(
        `SELECT pg_terminate_backend(pid)
           FROM pg_stat_activity
          WHERE datname = $1
            AND pid <> pg_backend_pid()`,
        [databaseName],
      );
      await adminPool.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      await adminPool.end();
    }
  }, 60_000);

  it('never ledgers 073 or 074 when IF NOT EXISTS leaves a partial end state', async () => {
    const dir073 = migrationOnlyDirectory('073_bitrix24_crm_sync.sql');
    temporaryDirectories.push(dir073);

    await pool.query(
      'CREATE INDEX idx_crm_sync_mapping_parent ON crm_sync_mapping (erp_id)',
    );
    const failed073 = runApply(dir073);
    expect(failed073.status).not.toBe(0);
    expect(failed073.output).toContain('end-state probe is still PENDING');
    expect(failed073.output).toContain('was NOT recorded in schema_migrations');
    const ledger073 = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM schema_migrations
        WHERE filename = '073_bitrix24_crm_sync.sql'`,
    );
    expect(ledger073.rows[0].count).toBe('0');

    await pool.query('DROP INDEX idx_crm_sync_mapping_parent');
    const repaired073 = runApply(dir073);
    expect(repaired073.status, repaired073.output).toBe(0);

    const dir074 = migrationOnlyDirectory('074_bitrix24_payment_delivery_guards.sql');
    temporaryDirectories.push(dir074);
    await pool.query(`
      CREATE TABLE crm_sync_payment_create_guard (
        erp_payment_id TEXT PRIMARY KEY
      );
      CREATE TABLE crm_sync_writer_lock (
        lock_name TEXT PRIMARY KEY
      );
    `);
    const failed074 = runApply(dir074);
    expect(failed074.status).not.toBe(0);
    expect(failed074.output).toContain('end-state probe is still PENDING');
    expect(failed074.output).toContain('was NOT recorded in schema_migrations');
    const ledger074 = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM schema_migrations
        WHERE filename = '074_bitrix24_payment_delivery_guards.sql'`,
    );
    expect(ledger074.rows[0].count).toBe('0');

    await pool.query(`
      DROP TABLE crm_sync_payment_create_guard;
      DROP TABLE crm_sync_writer_lock;
    `);
    const repaired074 = runApply(dir074);
    expect(repaired074.status, repaired074.output).toBe(0);

    const finalLedger = await pool.query<{ filename: string }>(
      'SELECT filename FROM schema_migrations ORDER BY filename',
    );
    expect(finalLedger.rows.map((row) => row.filename)).toEqual([
      '073_bitrix24_crm_sync.sql',
      '074_bitrix24_payment_delivery_guards.sql',
    ]);
  }, 120_000);
});
