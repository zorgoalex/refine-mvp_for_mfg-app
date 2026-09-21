import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Explicit opt-in. Only a randomly named disposable DB is mutated; no application
// tables, ledger, settings or remote APIs are touched. Requires CREATEDB rights.
const enabled = process.env.ERP_MIGRATION_PROBE_INTEGRATION === 'true';
const container = process.env.PG_CONTAINER || 'erp_test-postgresdb-1';
const db = `e2e_migration_probe_${randomBytes(10).toString('hex')}`;
const script = resolve(__dirname, 'apply-migrations.sh');
const source = readFileSync(script, 'utf8');
const dir = resolve(__dirname, '../backend/db/migrations');
const files = readdirSync(dir).filter((f) => /^16[4-9]_.*\.sql$/.test(f)
  || ['174_mdf_execution_context.sql','175_mdf_command_placement.sql'].includes(f)).sort();
const helpers = source.slice(source.indexOf('q_col()'), source.indexOf('# These migrations contain conditional'));
const queries = (file: string) => execFileSync('bash', ['-s', '--', file], {
  input: `${helpers}\nprobe_all() { printf '%s\\n' "$@"; }\nprobe_file "$1"`, encoding: 'utf8',
});
function sql(query: string, database = db) {
  return execFileSync('docker', ['exec', '-i', container, 'sh', '-lc',
    'exec psql -U "$POSTGRES_USER" -d "$1" -X -qAt -v ON_ERROR_STOP=1', 'probe-test', database],
  { input: query, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 });
}
const present = (file: string, mutation = '') => {
  const out = sql(`BEGIN; SET LOCAL statement_timeout='10s'; SET LOCAL lock_timeout='1s'; ${mutation}\n${queries(file)}\nROLLBACK;`);
  const values = out.trim().split('\n');
  expect(values.length).toBeGreaterThan(0);
  return values.every((v) => v === 't');
};
const fileFor = (version: number) => files.find((f) => f.startsWith(`${version}_`))!;

describe.skipIf(!enabled)('migration 164-169 and 174-175 probes against actual SQL on PostgreSQL', () => {
  let created = false;
  beforeAll(() => {
    sql(`CREATE DATABASE ${db} TEMPLATE template0;`, 'postgres');
    created = true;
    // Minimal pre-existing dependencies. New objects are created ONLY by the
    // committed migration SQL, not by a duplicated test schema.
    sql(`CREATE TABLE projects(code text);
      CREATE TABLE group_groups(code text);
      CREATE TABLE cnc_telegram_packet_whole_order_keys(order_key text);
      CREATE TABLE users(user_id bigint PRIMARY KEY);
      CREATE TABLE order_statuses(order_status_id smallint PRIMARY KEY);
      CREATE TABLE bitrix24_app_installation(member_id text PRIMARY KEY);
      CREATE TABLE orders(order_id bigint PRIMARY KEY,order_status_id smallint,edited_by bigint,order_kind text,delete_flag boolean);
      CREATE TABLE crm_sync_mapping(entity_type text,bitrix_object text,bitrix_id text,status text,erp_id text);`);
    for (const f of files) sql(readFileSync(resolve(dir, f), 'utf8'));
  }, 60000);
  afterAll(() => {
    if (created) sql(`DROP DATABASE ${db};`, 'postgres');
  });

  it.each(files)('%s: complete effect is PRESENT', (f) => expect(present(f)).toBe(true));

  it.each(files)('%s: real runner probe uses the same read-only checks', (f) => {
    const out = execFileSync('bash', [script, 'probe', f, '--container', container, '--db', db],
      { encoding: 'utf8', timeout: 60000 });
    expect(out).toContain(`${f} PRESENT`);
  }, 60000);

  it.each([
    [164, "ALTER TABLE projects DROP CONSTRAINT chk_projects_code; ALTER TABLE projects ADD CONSTRAINT chk_projects_code CHECK(code ~ '^[A-Za-z0-9-]{1,20}$');"],
    [164, "ALTER TABLE group_groups DROP CONSTRAINT chk_group_groups_code_format; ALTER TABLE group_groups ADD CONSTRAINT chk_group_groups_code_format CHECK(code ~ '^[[:alnum:]][[:alnum:]_-]{1,63}$') NOT VALID;"],
    [165, 'ALTER TABLE mdf_evidence_lines ALTER COLUMN quantity DROP NOT NULL;'],
    [165, 'ALTER TABLE mdf_source_heads DROP CONSTRAINT mdf_source_heads_source_kind_source_id_accepted_revision_k_fkey;'],
    [165, 'DROP INDEX idx_mdf_allocation_supply;'],
    [165, 'ALTER TABLE mdf_evidence_lines DISABLE TRIGGER mdf_line_immutable;'],
    [165, 'CREATE OR REPLACE FUNCTION mdf_guard_allocation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;'],
    [166, 'ALTER TABLE mdf_source_heads DISABLE TRIGGER mdf_source_fence_guard;'],
    [166, 'CREATE OR REPLACE FUNCTION mdf_guard_published_fence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;'],
    [167, 'ALTER TABLE mdf_shadow_observations DROP COLUMN candidate_quantities;'],
    [167, 'ALTER TABLE mdf_shadow_observations DISABLE TRIGGER mdf_shadow_immutable;'],
    [168, 'ALTER TABLE bitrix24_stage_config ALTER COLUMN enabled SET DEFAULT true;'],
    [168, 'ALTER TABLE bitrix24_stage_work DROP CONSTRAINT bitrix24_stage_work_pkey;'],
    [168, 'DROP INDEX idx_bitrix24_stage_work_due;'],
    [168, 'ALTER TABLE orders DISABLE TRIGGER trg_bitrix24_stage_order_changed;'],
    [168, 'ALTER TABLE crm_sync_mapping DISABLE TRIGGER trg_bitrix24_stage_mapping_available;'],
    [168, 'CREATE OR REPLACE FUNCTION bitrix24_stage_enqueue(p_order_id bigint) RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN; END $$;'],
    [168, 'DELETE FROM bitrix24_stage_config;'],
    [169, 'ALTER TABLE mdf_shadow_comparison_attempts DROP CONSTRAINT mdf_shadow_comparison_attempts_attempts_check;'],
    [169, 'ALTER TABLE mdf_shadow_comparisons DISABLE TRIGGER mdf_shadow_comparison_immutable;'],
    [169, 'DROP INDEX idx_mdf_shadow_comparison_created;'],
    [174, 'ALTER TABLE mdf_revision_context ALTER COLUMN acceptance_requested SET DEFAULT true;'],
    [174, 'ALTER TABLE mdf_revision_demand ALTER COLUMN quantity DROP NOT NULL;'],
    [174, 'ALTER TABLE mdf_published_sources DROP CONSTRAINT mdf_published_sources_source_kind_source_id_fkey;'],
    [174, 'ALTER TABLE mdf_published_source_members DROP CONSTRAINT mdf_published_source_members_quantity_check;'],
    [174, 'ALTER TABLE mdf_published_positions DROP CONSTRAINT mdf_published_positions_check;'],
    [174, 'DROP INDEX idx_mdf_published_source_window;'],
    [174, 'DROP INDEX idx_mdf_published_member_order;'],
    [174, 'ALTER TABLE mdf_revision_context DISABLE TRIGGER mdf_context_insert_guard;'],
    [174, 'ALTER TABLE mdf_revision_demand DISABLE TRIGGER mdf_demand_insert_guard;'],
    [174, 'ALTER TABLE mdf_revision_context DISABLE TRIGGER mdf_context_immutable;'],
    [174, 'ALTER TABLE mdf_revision_demand DISABLE TRIGGER mdf_demand_immutable;'],
    [174, 'CREATE OR REPLACE FUNCTION mdf_guard_execution_context_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;'],
    [174, 'DROP TRIGGER mdf_context_insert_guard ON mdf_revision_context; CREATE TRIGGER mdf_context_insert_guard BEFORE INSERT ON mdf_revision_context FOR EACH ROW WHEN (NEW.acceptance_requested) EXECUTE FUNCTION mdf_guard_execution_context_insert();'],
    [175, 'DROP TABLE mdf_manual_command_results;'],
    [175, 'ALTER TABLE mdf_manual_command_results DROP CONSTRAINT mdf_manual_command_results_pkey;'],
    [175, 'ALTER TABLE mdf_manual_command_results ALTER COLUMN response DROP NOT NULL;'],
    [175, 'ALTER TABLE mdf_manual_command_results DISABLE TRIGGER mdf_manual_command_result_immutable;'],
    [175, "ALTER TABLE mdf_revision_context DROP CONSTRAINT mdf_context_manual_placement_check; ALTER TABLE mdf_revision_context ADD CONSTRAINT mdf_context_manual_placement_check CHECK(true);"],
    [175, 'DROP TRIGGER mdf_manual_command_result_immutable ON mdf_manual_command_results; CREATE TRIGGER mdf_manual_command_result_immutable BEFORE UPDATE ON mdf_manual_command_results FOR EACH ROW EXECUTE FUNCTION mdf_reject_evidence_change();'],
  ] as const)('%s: rejects drift %s', (version, mutation) => {
    expect(present(fileFor(version), mutation)).toBe(false);
    expect(present(fileFor(version))).toBe(true); // rollback restored fixture
  });

  it('does not confuse legitimate runtime settings with a missing migration', () => {
    expect(present(fileFor(165), "UPDATE mdf_engine_state SET mode='shadow',published_revision=10;")).toBe(true);
    expect(present(fileFor(168), `INSERT INTO users VALUES(1); INSERT INTO order_statuses VALUES(1);
      INSERT INTO bitrix24_app_installation VALUES('E2E-member');
      UPDATE bitrix24_stage_config SET member_id='E2E-member',domain='example.invalid',category_id=0,
      completed_status_id=1,enabled=true,binding_locked=true,version=3,epoch=2;`)).toBe(true);
  });
});
