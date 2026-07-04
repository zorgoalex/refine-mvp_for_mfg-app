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

  it('non-sheet names are non-cuttable placeholders', () => {
    expect(classify('краска')).toBe('non-cuttable|1|3');
    expect(classify('Стекло 4мм')).toBe('non-cuttable|1|3');
    expect(classify('')).toBe('non-cuttable|1|3');
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
