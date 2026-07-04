import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * End-to-end rehearsal of `ops/apply-migrations.sh auto`: a v14 base schema
 * (the old-prod shape) is loaded into a SCRATCH database in the erp_test
 * postgres container, restored-dump fixtures are inserted, and the one-command
 * auto mode is exercised through its main journey and failure gates:
 * discriminator, Variant B coverage abort + --auto-map, full head bring-up,
 * idempotent rerun, 036/047 ledger holes, the 041 operator slot (pre-existing,
 * case-drift, --skip-041) and the persistent hard-stop sentinel.
 *
 * Scratch DB only — no erp_test data is touched; teardown drops the database.
 */
const CONTAINER = process.env.PG_CONTAINER ?? 'erp_test-postgresdb-1';
const DB = 'migration_auto_rehearsal_it';
const script = resolve(__dirname, 'apply-migrations.sh');
const v14 = '/home/ovhtest/projects/erp_dev/spec_erp/docs/reference/postgresql_schema_v_14.sql';

const containerUp = (() => {
  try {
    execFileSync('docker', ['inspect', CONTAINER], { stdio: 'ignore' });
    return existsSync(v14);
  } catch {
    return false;
  }
})();

const d = describe.skipIf(!containerUp);

function psql(sql: string): string {
  return execFileSync(
    'docker',
    ['exec', '-i', CONTAINER, 'sh', '-c',
      `psql -U "$POSTGRES_USER" -d ${DB} -v ON_ERROR_STOP=1 -qtAF '|'`],
    { encoding: 'utf8', input: sql },
  ).trim();
}

function psqlAdmin(sql: string): string {
  return execFileSync(
    'docker',
    ['exec', '-i', CONTAINER, 'sh', '-c',
      'psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 -qtA'],
    { encoding: 'utf8', input: sql },
  ).trim();
}

type RunResult = { ok: boolean; out: string };
function runAuto(args: string[], artifacts: string): RunResult {
  try {
    const out = execFileSync(
      'bash',
      [script, 'auto', '--db', DB, '--artifacts', artifacts, ...args],
      { encoding: 'utf8' },
    );
    return { ok: true, out };
  } catch (e: any) {
    return { ok: false, out: `${e.stdout ?? ''}\n${e.stderr ?? ''}` };
  }
}

let artifacts: string;

d('apply-migrations.sh auto — restored-dump rehearsal (scratch DB)', () => {
  beforeAll(() => {
    artifacts = mkdtempSync(join(tmpdir(), 'migration-auto-it-'));
    psqlAdmin(`DROP DATABASE IF EXISTS ${DB};`);
    psqlAdmin(`CREATE DATABASE ${DB};`);
    // The v14 reference file is not dependency-ordered — load it iteratively
    // until the object graph converges (later passes only emit already-exists
    // noise, which is ignored).
    for (let pass = 0; pass < 3; pass++) {
      execFileSync(
        'docker',
        ['exec', '-i', CONTAINER, 'sh', '-c',
          `psql -U "$POSTGRES_USER" -d ${DB} -q -v ON_ERROR_STOP=0`],
        { encoding: 'utf8', input: readFileSync(v14, 'utf8'), stdio: ['pipe', 'ignore', 'ignore'] },
      );
    }
    expect(psql(`SELECT to_regclass('orders') IS NOT NULL;`)).toBe('t');
  });

  afterAll(() => {
    psqlAdmin(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE);`);
    rmSync(artifacts, { recursive: true, force: true });
  });

  it('refuses an empty orders table without --assume-restored (discriminator)', () => {
    const r = runAuto(['--yes'], artifacts);
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/--assume-restored/);
  });

  it('accepts restored-dump fixtures (legacy material on a detail)', () => {
    psql(`
      INSERT INTO units (unit_id, unit_code) VALUES (1, 'шт') ON CONFLICT DO NOTHING;
      INSERT INTO material_types (material_type_id, material_type_name, sort_order)
        VALUES (1, 'МДФ', 1), (3, 'Прочее', 3) ON CONFLICT DO NOTHING;
      INSERT INTO milling_types (milling_type_id, milling_type_name, sort_order) VALUES (1, 'Тест-фрезеровка', 1) ON CONFLICT DO NOTHING;
      INSERT INTO edge_types (edge_type_id, edge_type_name, sort_order) VALUES (1, 'Тест-кромка', 1) ON CONFLICT DO NOTHING;
      INSERT INTO users (username, email, password_hash) VALUES ('test_migauto', 'migauto@example.com', 'x');
      SELECT set_session_user((SELECT min(user_id) FROM users));
      INSERT INTO clients (client_name) VALUES ('Тест-клиент');
      INSERT INTO materials (material_name, unit_id, material_type_id) VALUES ('Тест-МДФ 19мм', 1, 1);
      INSERT INTO orders (order_name, client_id, order_status_id, payment_status_id, created_by)
        SELECT 'Тест-заказ-1', c.client_id, min(os.order_status_id), min(ps.payment_status_id), min(u.user_id)
        FROM clients c, order_statuses os, payment_statuses ps, users u GROUP BY c.client_id;
      INSERT INTO order_details (order_id, detail_number, height, width, area, material_id, milling_type_id, edge_type_id, created_by, quantity)
        SELECT o.order_id, 1, 100, 200, 0.02, m.material_id, 1, 1, u.user_id, 1
        FROM orders o, materials m, users u LIMIT 1;
    `);
    expect(psql('SELECT count(*) FROM order_details;')).toBe('1');
  });

  it('aborts at the Variant B gate with a candidates artifact (no --auto-map)', () => {
    const r = runAuto(['--yes'], artifacts);
    expect(r.ok).toBe(false);
    expect(r.out).toMatch(/conversion map does not cover/);
    const cand = readFileSync(join(artifacts, 'conversion-map-candidates.sql'), 'utf8');
    expect(cand).toContain('Тест-МДФ 19мм');
    expect(cand).toMatch(/AUTO_MAT_\d+.*true, 1, 1, 2800, 2070, 19/);
    // delta below 033 already applied and ledgered
    expect(psql(`SELECT count(*) FROM schema_migrations WHERE filename LIKE '033%';`)).toBe('1');
  });

  it('completes to head with --auto-map and converts the legacy material', () => {
    const r = runAuto(['--yes', '--auto-map'], artifacts);
    expect(r.ok, r.out).toBe(true);
    expect(r.out).toMatch(/pending: 0/);
    expect(r.out).toMatch(/auto: DONE/);
    expect(psql('SELECT sheet_material_type_id IS NOT NULL, material_id IS NULL FROM order_details;')).toBe('t|t');
    expect(psql(`SELECT is_cuttable, thickness_mm::int FROM sheet_material_types WHERE conversion_key LIKE 'AUTO_MAT_%';`)).toBe('t|19');
    expect(psql(`SELECT count(*) FROM schema_migrations WHERE filename LIKE 'zz_automap%';`)).toBe('1');
    // 003 was never executed on the restore path; 034 rebuilt orders_view with the guard
    expect(psql(`SELECT pg_get_viewdef('orders_view') LIKE '%2147483647%';`)).toBe('t');
    // 041 ran on freshly seeded templates (all created by this run)
    expect(Number(psql('SELECT count(*) FROM label_template_elements;'))).toBeGreaterThan(0);
  });

  it('is an idempotent no-op on rerun', () => {
    const r = runAuto(['--yes'], artifacts);
    expect(r.ok, r.out).toBe(true);
    expect(r.out).toMatch(/pending: 0/);
  });

  it('heals mid-history ledger holes (the 036/047 incident class)', () => {
    psql(`
      SELECT set_session_user((SELECT min(user_id) FROM users));
      DROP VIEW order_details_view;
      ALTER TABLE order_details DROP COLUMN basis_project, DROP COLUMN basis_data;
      CREATE OR REPLACE VIEW order_details_view AS
      SELECT od.detail_id, od.order_id, od.detail_number, od.detail_name, od.height, od.width,
             od.quantity, od.area, od.material_id, od.sheet_material_type_id, smt.name AS material_name,
             od.milling_type_id, od.edge_type_id, od.film_id, od.milling_cost_per_sqm, od.detail_cost,
             od.priority, od.production_status_id, od.joint_order_id, od.note, od.link_cutting_file,
             od.link_cutting_image_file, od.link_cad_file, od.link_pdf_file, od.ref_key_1c
      FROM order_details od
      JOIN orders ord ON ord.order_id = od.order_id AND ord.delete_flag = false
      LEFT JOIN sheet_material_types smt ON smt.sheet_material_type_id = od.sheet_material_type_id
      WHERE od.delete_flag = false;
      ALTER TABLE label_template_elements DROP CONSTRAINT chk_label_template_elements_kind;
      ALTER TABLE label_template_elements ADD CONSTRAINT chk_label_template_elements_kind CHECK (kind IN ('text','line','rect'));
      DELETE FROM schema_migrations WHERE filename IN ('036_order_detail_basis_fields.sql','047_label_template_qr_kind.sql');
    `);
    const r = runAuto(['--yes'], artifacts);
    expect(r.ok, r.out).toBe(true);
    expect(r.out).toMatch(/036_order_detail_basis_fields\.sql\s+PENDING/);
    expect(r.out).toMatch(/047_label_template_qr_kind\.sql\s+PENDING/);
    expect(psql(`SELECT pg_get_viewdef('order_details_view') LIKE '%basis_project%';`)).toBe('t');
    expect(psql(`SELECT pg_get_constraintdef(oid) LIKE '%qr%' FROM pg_constraint WHERE conname='chk_label_template_elements_kind';`)).toBe('t');
  });

  it('041 slot: pre-existing template forces an operator decision; --skip-041 preserves layouts', () => {
    psql(`DELETE FROM schema_migrations WHERE filename LIKE '041%';`);
    const stop = runAuto(['--yes'], artifacts);
    expect(stop.ok).toBe(false);
    expect(stop.out).toMatch(/041 needs an operator decision/);
    expect(stop.out).toMatch(/\[exact\] Стандартная бирка Bazis 85x88/);

    const before = psql('SELECT count(*) FROM label_template_elements;');
    const skip = runAuto(['--yes', '--skip-041'], artifacts);
    expect(skip.ok, skip.out).toBe(true);
    expect(psql('SELECT count(*) FROM label_template_elements;')).toBe(before);
    expect(psql(`SELECT count(*) FROM schema_migrations WHERE filename LIKE '041%';`)).toBe('1');
  });

  it('041 slot: case-drifted template is reported drifted, never a silent no-op', () => {
    psql(`
      SELECT set_session_user((SELECT min(user_id) FROM users));
      DELETE FROM schema_migrations WHERE filename LIKE '041%';
      UPDATE label_templates SET name = upper(name) WHERE lower(name)=lower('Стандартная бирка Bazis 85x88');
    `);
    const stop = runAuto(['--yes'], artifacts);
    expect(stop.ok).toBe(false);
    expect(stop.out).toMatch(/drifted/);
    expect(stop.out).toMatch(/СТАНДАРТНАЯ БИРКА BAZIS 85X88/);
    const skip = runAuto(['--yes', '--skip-041'], artifacts);
    expect(skip.ok, skip.out).toBe(true);
  });

  it('heals a 031 hole (dropped-index migration probed by END-state, not old state)', () => {
    // Pre-031 state: the global exclusivity guard exists, 031's replacements do not.
    psql(`
      DROP INDEX IF EXISTS uq_cut_job_item_active_job_detail;
      DROP INDEX IF EXISTS idx_cut_job_item_order_detail;
      CREATE UNIQUE INDEX uq_cut_job_item_active_detail ON cut_job_item (order_detail_id) WHERE is_active = true;
      DELETE FROM schema_migrations WHERE filename LIKE '031%';
    `);
    const r = runAuto(['--yes'], artifacts);
    expect(r.ok, r.out).toBe(true);
    expect(r.out).toMatch(/031_cut_detail_multi_job\.sql\s+PENDING/);
    expect(psql(`SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='uq_cut_job_item_active_job_detail');`)).toBe('t');
    expect(psql(`SELECT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='idx_cut_job_item_order_detail');`)).toBe('t');
    expect(psql(`SELECT NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname='uq_cut_job_item_active_detail');`)).toBe('t');
  });

  it('hard-stop sentinel blocks apply AND auto until --clear-hard-stop', () => {
    psql(`INSERT INTO schema_migrations (filename, checksum) VALUES ('zz_hard_stop_034_it', 'verify-failed:it');`);
    expect(() =>
      execFileSync('bash', [script, 'apply', '--yes', '--db', DB], { encoding: 'utf8' }),
    ).toThrow(/HARD-STOP|hard-stop|zz_hard_stop/i);
    const blocked = runAuto(['--yes'], artifacts);
    expect(blocked.ok).toBe(false);
    expect(blocked.out).toMatch(/HARD-STOP/);
    const cleared = runAuto(['--yes', '--clear-hard-stop'], artifacts);
    expect(cleared.ok, cleared.out).toBe(true);
  });
});

const DB2 = 'migration_auto_rehearsal_it2';

d('apply-migrations.sh auto — approved recovery path: edit committed 033 and rerun', () => {
  let artifacts2: string;
  let migCopy: string;

  function psql2(sql: string): string {
    return execFileSync(
      'docker',
      ['exec', '-i', CONTAINER, 'sh', '-c',
        `psql -U "$POSTGRES_USER" -d ${DB2} -v ON_ERROR_STOP=1 -qtAF '|'`],
      { encoding: 'utf8', input: sql },
    ).trim();
  }
  function runAuto2(args: string[]): RunResult {
    try {
      const out = execFileSync(
        'bash',
        [script, 'auto', '--db', DB2, '--artifacts', artifacts2, '--dir', migCopy, ...args],
        { encoding: 'utf8' },
      );
      return { ok: true, out };
    } catch (e: any) {
      return { ok: false, out: `${e.stdout ?? ''}\n${e.stderr ?? ''}` };
    }
  }

  beforeAll(() => {
    artifacts2 = mkdtempSync(join(tmpdir(), 'migration-auto-it2-'));
    migCopy = mkdtempSync(join(tmpdir(), 'migration-auto-migcopy-'));
    const migDir = resolve(__dirname, '..', 'backend', 'db', 'migrations');
    for (const f of readdirSync(migDir)) {
      if (/\.sql$/.test(f)) {
        execFileSync('cp', [join(migDir, f), join(migCopy, f)]);
      }
    }
    psqlAdmin(`DROP DATABASE IF EXISTS ${DB2};`);
    psqlAdmin(`CREATE DATABASE ${DB2};`);
    for (let pass = 0; pass < 3; pass++) {
      execFileSync(
        'docker',
        ['exec', '-i', CONTAINER, 'sh', '-c',
          `psql -U "$POSTGRES_USER" -d ${DB2} -q -v ON_ERROR_STOP=0`],
        { encoding: 'utf8', input: readFileSync(v14, 'utf8'), stdio: ['pipe', 'ignore', 'ignore'] },
      );
    }
    psql2(`
      INSERT INTO units (unit_id, unit_code) VALUES (1, 'шт') ON CONFLICT DO NOTHING;
      INSERT INTO material_types (material_type_id, material_type_name, sort_order)
        VALUES (1, 'МДФ', 1), (3, 'Прочее', 3) ON CONFLICT DO NOTHING;
      INSERT INTO milling_types (milling_type_id, milling_type_name, sort_order) VALUES (1, 'Т', 1) ON CONFLICT DO NOTHING;
      INSERT INTO edge_types (edge_type_id, edge_type_name, sort_order) VALUES (1, 'Т', 1) ON CONFLICT DO NOTHING;
      INSERT INTO users (username, email, password_hash) VALUES ('test_migauto2', 'migauto2@example.com', 'x');
      SELECT set_session_user((SELECT min(user_id) FROM users));
      INSERT INTO clients (client_name) VALUES ('Тест-клиент');
      INSERT INTO materials (material_name, unit_id, material_type_id) VALUES ('Тест-ХДФ 8мм', 1, 3);
      INSERT INTO orders (order_name, client_id, order_status_id, payment_status_id, created_by)
        SELECT 'Тест-заказ-2', c.client_id, min(os.order_status_id), min(ps.payment_status_id), min(u.user_id)
        FROM clients c, order_statuses os, payment_statuses ps, users u GROUP BY c.client_id;
      INSERT INTO order_details (order_id, detail_number, height, width, area, material_id, milling_type_id, edge_type_id, created_by, quantity)
        SELECT o.order_id, 1, 100, 200, 0.02, m.material_id, 1, 1, u.user_id, 1
        FROM orders o, materials m, users u LIMIT 1;
    `);
  });

  afterAll(() => {
    psqlAdmin(`DROP DATABASE IF EXISTS ${DB2} WITH (FORCE);`);
    rmSync(artifacts2, { recursive: true, force: true });
    rmSync(migCopy, { recursive: true, force: true });
  });

  it('coverage abort leaves 033 ledgered; committing rows into 033 + rerun replays the manifest', () => {
    const abort = runAuto2(['--yes']);
    expect(abort.ok).toBe(false);
    expect(abort.out).toMatch(/conversion map does not cover/);
    expect(psql2(`SELECT count(*) FROM schema_migrations WHERE filename LIKE '033%';`)).toBe('1');

    // Operator commits the reviewed candidate row into 033 (here: the copy).
    const f033 = join(migCopy, '033_order_material_conversion_map.sql');
    const mid = psql2(`SELECT material_id FROM materials WHERE material_name='Тест-ХДФ 8мм';`);
    const row = `\nINSERT INTO sheet_material_conversion_map (legacy_material_id, target_key, target_sheet_name, is_cuttable, target_unit_id, target_material_type_id, target_width_mm, target_height_mm, target_thickness_mm) VALUES (${mid}, 'TEST_XDF_8', 'Тест-ХДФ 8мм', true, 1, 3, 2800, 2070, 8) ON CONFLICT DO NOTHING;\n`;
    // Append INSIDE the migration file (after the seed inserts, before COMMIT).
    const orig = readFileSync(f033, 'utf8');
    execFileSync('bash', ['-c', `cat > ${JSON.stringify(f033)}`], {
      input: orig.replace(/COMMIT;\s*$/, `${row}COMMIT;\n`),
    });

    const rerun = runAuto2(['--yes']);
    expect(rerun.ok, rerun.out).toBe(true);
    expect(rerun.out).toMatch(/was edited after it was ledgered — replaying/);
    expect(rerun.out).toMatch(/pending: 0/);
    expect(psql2(`SELECT is_cuttable, thickness_mm::int FROM sheet_material_types WHERE conversion_key='TEST_XDF_8';`)).toBe('t|8');
    expect(psql2('SELECT sheet_material_type_id IS NOT NULL, material_id IS NULL FROM order_details;')).toBe('t|t');
    // Ledger checksum refreshed — a third run is a clean no-op.
    const again = runAuto2(['--yes']);
    expect(again.ok, again.out).toBe(true);
    expect(again.out).not.toMatch(/replaying/);
  });
});
