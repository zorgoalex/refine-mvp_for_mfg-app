import { randomBytes } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Explicit opt-in. Only a randomly named disposable DB is mutated (no ledger: a restored schema whose ledger lacks
// 173/289). Requires CREATEDB rights. Same switch as apply-migrations-recent.integration.test.ts.
const enabled = process.env.ERP_MIGRATION_PROBE_INTEGRATION === 'true';
const container = process.env.PG_CONTAINER || 'erp_test-postgresdb-1';
const db = `e2e_migration_probe_inbound_${randomBytes(8).toString('hex')}`;
const script = resolve(__dirname, 'apply-migrations.sh');
const dir = resolve(__dirname, '../backend/db/migrations');
const M173 = '173_inbound_signals.sql', M289 = '289_inbound_signal_segments.sql';
function sql(query: string, database = db) {
  return execFileSync('docker', ['exec', '-i', container, 'sh', '-lc',
    'exec psql -U "$POSTGRES_USER" -d "$1" -X -qAt -v ON_ERROR_STOP=1', 'probe-test', database],
  { input: query, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 });
}
// The runner prints «<file> PRESENT» (exit 0) or «<file> PENDING» (exit 1).
const probe = (file: string) => {
  const run = spawnSync('bash', [script, 'probe', file, '--container', container, '--db', db], { encoding: 'utf8', timeout: 60000 });
  const verdict = `${run.stdout}`.includes(`${file} PRESENT`) ? 'PRESENT' : `${run.stdout}`.includes(`${file} PENDING`) ? 'PENDING' : 'ERROR';
  expect(run.status, run.stderr).toBe(verdict === 'PRESENT' ? 0 : 1);
  return `${file} ${verdict}`;
};

describe.skipIf(!enabled)('migration runner: 173 and 289 on a restored schema without ledger rows', () => {
  let created = false;
  beforeAll(() => {
    sql(`CREATE DATABASE ${db} TEMPLATE template0;`, 'postgres');
    created = true;
    sql(`CREATE TABLE users(user_id bigint PRIMARY KEY); CREATE TABLE orders(order_id bigint PRIMARY KEY);
      CREATE TABLE permissions_catalog(permission_name text PRIMARY KEY,domain text,label text,description text,sort_order int,is_dangerous boolean,is_active boolean);
      CREATE TABLE roles(role_id bigint PRIMARY KEY,role_code text);
      CREATE TABLE role_permissions(role_id bigint,permission_name text,is_enabled boolean,PRIMARY KEY(role_id,permission_name));
      CREATE TABLE permissions_state(id boolean PRIMARY KEY,version int,updated_at timestamptz); INSERT INTO permissions_state VALUES(true,1,now());`);
    sql(readFileSync(resolve(dir, M173), 'utf8'));
  }, 60000);
  afterAll(() => { if (created) sql(`DROP DATABASE ${db};`, 'postgres'); });

  it('before 289: 173 PRESENT, 289 PENDING', () => {
    expect(probe(M173)).toContain(`${M173} PRESENT`);
    expect(probe(M289)).toContain(`${M289} PENDING`);
  }, 120000);

  it('after 289 (applied twice): 173 PRESENT, 289 PRESENT, old key gone, data kept', () => {
    sql(`INSERT INTO users VALUES (1); INSERT INTO orders VALUES (1);`);
    sql(readFileSync(resolve(dir, M289), 'utf8'));
    sql(readFileSync(resolve(dir, M289), 'utf8'));
    expect(probe(M173)).toContain(`${M173} PRESENT`);
    expect(probe(M289)).toContain(`${M289} PRESENT`);
    expect(sql(`SELECT conname FROM pg_constraint WHERE conrelid='inbound_signal_occurrences'::regclass AND contype='u' ORDER BY 1;`).trim())
      .toBe('inbound_signal_occurrences_message_signal_segment_key');
  }, 120000);

  it('a partial 289 (columns without the new key) stays PENDING', () => {
    sql(`ALTER TABLE inbound_signal_occurrences DROP CONSTRAINT inbound_signal_occurrences_message_signal_segment_key;`);
    expect(probe(M289)).toContain(`${M289} PENDING`);
    sql(readFileSync(resolve(dir, M289), 'utf8'));
    expect(probe(M289)).toContain(`${M289} PRESENT`);
  }, 120000);
});
