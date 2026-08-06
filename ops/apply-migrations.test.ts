import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const script = resolve(__dirname, 'apply-migrations.sh');
const migDir = resolve(__dirname, '..', 'backend', 'db', 'migrations');
const scriptText = readFileSync(script, 'utf8');

function run(args: string[]) {
  return execFileSync('bash', [script, ...args], { encoding: 'utf8' });
}

describe('apply-migrations.sh auto — classification completeness guard', () => {
  // Every runner-selected migration file MUST have an auto-mode classification:
  // a probe_file() case arm, or the dedicated 003/041 policy logic. A new
  // migration landing without one must fail this test (probe map maintenance).
  const files = readdirSync(migDir)
    .filter((f) => /^[0-9].*\.sql$/.test(f))
    .filter((f) => !/_(preflight|verify|rollback)\.sql$/.test(f))
    .sort();

  it('finds the migration set (sanity)', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files).toContain('034_order_material_sunset_legacy.sql');
  });

  // Scope the arm scan to the probe_file() function body only — an arm in the
  // apply loop (e.g. the 034 gate) must NOT satisfy the classification guard.
  const probeFnStart = scriptText.indexOf('probe_file() {');
  const probeFnEnd = scriptText.indexOf('# 003 policy probe', probeFnStart);
  const probeFn = scriptText.slice(probeFnStart, probeFnEnd);

  it('scopes the guard to the probe_file body (sanity)', () => {
    expect(probeFnStart).toBeGreaterThan(-1);
    expect(probeFnEnd).toBeGreaterThan(probeFnStart);
    expect(probeFn).toContain('esac');
  });

  it.each(files)('%s is classified in auto mode', (f) => {
    if (f.startsWith('003_') || f.startsWith('041_')) {
      // Dedicated policy / deferred-slot logic, asserted below.
      return;
    }
    // A case arm must match this file INSIDE probe_file(). Reproduce the shell
    // matching: an arm pattern like `034_*)` or `040_seed_standard_label_template*)`.
    const arms = [...probeFn.matchAll(/^\s+([0-9][A-Za-z0-9_]*)\*\)/gm)].map((m) => m[1]);
    const matched = arms.some((prefix) => f.startsWith(prefix));
    expect(matched, `probe_file() has no case arm for ${f} — extend the probe map`).toBe(true);
  });

  it('003 has the policy probe and 041 the deferred slot', () => {
    expect(scriptText).toMatch(/probe_003_guard\(\)/);
    expect(scriptText).toMatch(/2147483647/);
    expect(scriptText).toMatch(/DEFERRED \(decided at its apply slot/);
    expect(scriptText).toMatch(/--run-041-reset/);
    expect(scriptText).toMatch(/--skip-041/);
  });

  it('the three 040_* files have distinct arms (filename-keyed map)', () => {
    expect(scriptText).toMatch(/040_cut_job_sheet_material\*/);
    expect(scriptText).toMatch(/040_seed_standard_label_template\*/);
    expect(scriptText).toMatch(/040_user_preferences\*/);
  });

  it('fingerprints every realtime constraint, function, and statement trigger', () => {
    const requiredConstraints = [
      'order_realtime_stream_pkey',
      'order_realtime_stream_order_id_fkey',
      'chk_order_realtime_stream_commit_sequence',
      'chk_order_realtime_stream_detail_status_revision',
      'chk_order_realtime_stream_cut_refs_revision',
      'pk_realtime_event_log',
      'realtime_event_log_order_id_fkey',
      'uq_realtime_event_log_source',
      'chk_realtime_event_log_commit_sequence',
      'chk_realtime_event_log_schema_version',
      'chk_realtime_event_log_domains',
      'chk_realtime_event_log_domain_revisions',
    ];
    const sql098 = readFileSync(resolve(migDir, '098_order_realtime_producer_bridge.sql'), 'utf8');
    const requiredFunctions = [...sql098.matchAll(/CREATE OR REPLACE FUNCTION\s+(\w+)/g)]
      .map((match) => match[1]);
    const requiredTriggers = [...sql098.matchAll(/CREATE TRIGGER\s+(\w+)/g)]
      .map((match) => match[1]);

    expect(requiredFunctions).toHaveLength(18);
    expect(requiredTriggers).toHaveLength(11);
    for (const name of requiredConstraints) expect(probeFn).toContain(`q_con_hash_on ${name} `);
    for (const name of requiredFunctions) expect(probeFn).toContain(`q_fun_hash '${name}(`);
    for (const name of requiredTriggers) expect(probeFn).toContain(`q_stmt_trg ${name} `);
    expect(scriptText).toMatch(/q_fun_hash\(\).*md5\(pg_get_functiondef\(oid\)\)/);
    expect(scriptText).not.toMatch(/q_fun_hash\(\).*md5\(prosrc\)/);
    expect(probeFn.match(/q_fun_hash '[^']+' [a-f0-9]{32}/g)).toHaveLength(19);
  });

  it('requires realtime end-state probes before advancing the migration ledger', () => {
    const verifyStart = scriptText.indexOf('verify_applied_effect() {');
    const verifyEnd = scriptText.indexOf('probe_076_endstate()', verifyStart);
    const verifyFn = scriptText.slice(verifyStart, verifyEnd);
    expect(verifyFn).toMatch(/\|097_\*\|098_\*\|099_\*\|100_\*\|101_\*\|102_\*\|103_\*\|104_\*\|105_\*\|106_\*\|107_\*\)/);
    expect(scriptText).toMatch(/verify_applied_effect "\$f"[\s\S]*INSERT INTO schema_migrations/);
  });

  it('pins all migration 101 effect markers', () => {
    expect(probeFn).toContain('101_export_templates*');
    expect(probeFn).toContain('q_tbl export_templates');
    expect(probeFn).toContain('q_col export_templates schema_version');
    expect(probeFn).toContain('q_con_on export_templates chk_export_templates_target_source');
    expect(probeFn).toContain('q_con_on export_templates chk_export_templates_default_active');
    expect(probeFn).toContain('q_idx uq_export_templates_code');
    expect(probeFn).toContain('q_idx uq_export_templates_live_name');
    expect(probeFn).toContain('q_idx uq_export_templates_active_default');
    expect(probeFn).toContain('q_idx idx_export_templates_runtime');
    const migration101Probe = probeFn.slice(probeFn.indexOf('101_export_templates*'), probeFn.indexOf('*) return 2'));
    expect(migration101Probe).not.toContain('bazis-cut-set-standard-v1');
    expect(migration101Probe).not.toContain('bazis-project-cut-standard-v1');
  });

  it('pins migration 102 Bazis designer effect markers', () => {
    expect(probeFn).toContain('102_bazis_project_design_engineer*');
    expect(probeFn).toContain('q_col bazis_projects design_engineer_id');
    expect(probeFn).toContain('q_col bazis_projects design_engineer_xml_name');
    expect(probeFn).toContain('q_col bazis_projects design_engineer_source');
    expect(probeFn).toContain('q_con_on bazis_projects chk_bazis_projects_design_engineer_source');
    expect(probeFn).toContain('q_idx bazis_projects_design_engineer_idx');
  });

  it('pins migrations 103/104/105 Bazis product and panel-link end states', () => {
    expect(probeFn).toContain('103_bazis_cut_position_sources*');
    expect(probeFn).toContain('bazis-cut-position-v4:');
    expect(probeFn).toContain('104_bazis_order_detail_product_mapping*');
    expect(probeFn).toContain('Basis product name from the panel-level Product column');
    expect(probeFn).toContain('104_bazis_panel_order_links*');
    expect(probeFn).toContain('q_col bazis_node_order_detail_map import_source');
    expect(probeFn).toContain('q_con_hash_on bazis_node_order_detail_map_mapping_kind_check');
    expect(probeFn).toContain("q_fun_hash 'reconcile_bazis_panel_order_links(bigint,bigint[],text,bigint,text)'");
    expect(probeFn).toContain('v104 exact current-revision Basis PDF detail to Bazis panel reconciliation');
    expect(probeFn).toContain('105_bazis_order_detail_product_link_fallback*');
    expect(probeFn).toContain("products.root_product_count <= 1");
  });
});

describe('apply-migrations.sh auto — semantic view markers (pinned to real SQL)', () => {
  // The 034 end-state probe distinguishes pre/post Variant B view forms by the
  // absence of the legacy materials fallback `m.material_name`. Pin that
  // boundary against the actual migration texts so a future view rewrite that
  // breaks the invariant fails here.
  const sql034 = readFileSync(resolve(migDir, '034_order_material_sunset_legacy.sql'), 'utf8');
  const sql036 = readFileSync(resolve(migDir, '036_order_detail_basis_fields.sql'), 'utf8');
  const sql029 = readFileSync(resolve(migDir, '029_order_sheet_material_type.sql'), 'utf8');

  it('probe uses the m.material_name absence marker', () => {
    expect(scriptText).toMatch(/NOT LIKE '%m\.material_name%'/);
  });

  it('pre-034 form (029) HAS the legacy fallback; post forms (034/036) do NOT', () => {
    const viewBlock = (sql: string, view: string) => {
      const start = sql.indexOf(`CREATE OR REPLACE VIEW ${view}`);
      expect(start, `${view} not found`).toBeGreaterThan(-1);
      const rest = sql.slice(start);
      const end = rest.indexOf(';', rest.indexOf('FROM'));
      return rest.slice(0, end > 0 ? end : undefined);
    };
    expect(viewBlock(sql029, 'order_details_view')).toContain('m.material_name');
    expect(viewBlock(sql034, 'order_details_view')).not.toContain('m.material_name');
    expect(viewBlock(sql036, 'order_details_view')).not.toContain('m.material_name');
    for (const v of ['orders_view', 'orders_alias_view', 'doweling_orders_view', 'details_of_order']) {
      expect(viewBlock(sql034, v)).not.toContain('m.material_name');
    }
  });

  it('all five 034 views are probed', () => {
    for (const v of ['orders_view', 'order_details_view', 'orders_alias_view', 'doweling_orders_view', 'details_of_order']) {
      expect(scriptText).toContain(v);
    }
  });
});

describe('apply-migrations.sh classify-material-name (auto-map heuristic)', () => {
  const classify = (name: string) => run(['classify-material-name', name]).trim();

  it('sheet materials are cuttable with parsed thickness', () => {
    expect(classify('МДФ 19мм')).toBe('cuttable|19|1');
    expect(classify('черновой МДФ 16мм')).toBe('cuttable|16|1');
    expect(classify('ЛДСП 10 мм')).toBe('cuttable|10|3');
    expect(classify('ХДФ 3мм белый')).toBe('cuttable|3|3');
    expect(classify('ФАНЕРА')).toBe('cuttable|16|3'); // no thickness -> default 16
  });

  it('non-sheet names are UNKNOWN (placement decides the final row)', () => {
    // On a detail an unknown name becomes a cuttable SENTINEL (1×1×1 dims);
    // header-only stays non-cuttable — asserted in the integration rehearsal.
    expect(classify('краска')).toBe('unknown|1|3');
    expect(classify('Стекло 4мм')).toBe('unknown|1|3');
    expect(classify('')).toBe('unknown|1|3');
  });

  it('sentinel row shape for unknown detail materials is pinned in the script', () => {
    // ALL required sheet fields are 1 so the operator can find these later
    // (WHERE width_mm = 1) — user-directed behavior 2026-07-04.
    expect(scriptText).toMatch(/true, 1, 1, 1, 1, 1\) ON CONFLICT DO NOTHING;\s+-- SENTINEL/);
  });
});

describe('apply-migrations.sh — hard-stop is enforced in all mutating modes', () => {
  it('apply/baseline/mark-applied call the shared hard_stop_gate', () => {
    const dispatch = scriptText.slice(scriptText.indexOf('# --- Dispatch'));
    for (const mode of ['apply)', 'baseline)', 'mark-applied)']) {
      const idx = dispatch.indexOf(mode);
      expect(idx, `${mode} not found`).toBeGreaterThan(-1);
      const head = dispatch.slice(idx, idx + 200);
      expect(head, `${mode} must call hard_stop_gate first`).toContain('hard_stop_gate');
    }
  });

  it('auto clears the sentinel only with --clear-hard-stop', () => {
    expect(scriptText).toMatch(/CLEAR_HARD_STOP.*-eq 1.*ledger_exists/);
    expect(scriptText).toMatch(/DELETE FROM schema_migrations WHERE filename LIKE '\$\{HARD_STOP_PREFIX\}%'/);
  });
});

describe('apply-migrations.sh auto — detect-only against the live erp_test container', () => {
  // Cheap live smoke: erp_test is at head, so detect-only must classify every
  // file as applied/PRESENT and exit 0 without mutating anything. Skips when
  // the container is not reachable (e.g. CI without the stage stack).
  const containerUp = (() => {
    try {
      execFileSync('docker', ['inspect', process.env.PG_CONTAINER ?? 'erp_test-postgresdb-1'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!containerUp)('classifies the full head as applied/PRESENT', () => {
    const out = run(['auto', '--detect-only']);
    expect(out).toMatch(/detect-only: nothing changed/);
    expect(out).not.toMatch(/PENDING \(will apply\)/);
    expect(out).not.toMatch(/no classification/);
  }, 180_000);
});
