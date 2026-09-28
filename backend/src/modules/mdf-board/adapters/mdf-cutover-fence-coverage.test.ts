/**
 * §5.7b static coverage guard (no DB): every table read by the read-path loaders that classify/discover legacy MDF
 * history (`mdf-reconciliation-inventory.ts`, `mdf-shadow-proof-loader.ts`, `mdf-shadow-source.ts`) and by the
 * closed-order "current live demand" query (`loadMdfExecutionDetails`, `mdf-execution-snapshot.ts`) must be inside the
 * `mdf_cutover_fence` trigger list of migration 195. If a new table is added to one of these loaders without also
 * adding it to the fence array, a population run could read (or a stray write could slip past) an unfenced table
 * during the freeze. `audit_log` is intentionally excluded (read-only correlation data, not engine/inventory state).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const backendRoot = new URL('../../../../', import.meta.url);
const read = (relative: string) => readFileSync(new URL(relative, backendRoot), 'utf8');

const SQL_FUNCTIONS = new Set(['unnest', 'jsonb_array_elements', 'jsonb_to_recordset', 'jsonb_each', 'generate_series', 'lateral']);
const EXCLUDED_TABLES = new Set(['audit_log']);

/** Every identifier that follows FROM/JOIN in this source's embedded SQL template literals, excluding schema-qualified
 * alias references (e.g. `c.target_column` from an `IS NOT DISTINCT FROM c.target_column` comparison, never a table)
 * and PostgreSQL set-returning functions used as a FROM item. */
function extractTables(source: string): Set<string> {
  const tables = new Set<string>();
  const re = /\b(?:FROM|JOIN)\s+([A-Za-z_][A-Za-z0-9_.]*)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source))) {
    const name = match[1];
    if (name.includes('.') || SQL_FUNCTIONS.has(name.toLowerCase())) continue;
    tables.add(name);
  }
  return tables;
}

function extractFenceTableList(migrationSql: string): string[] {
  const block = migrationSql.match(/FOREACH t IN ARRAY ARRAY\[([\s\S]*?)\]\s*\n\s*LOOP/);
  if (!block) throw new Error('MDF_FENCE_ARRAY_NOT_FOUND');
  return [...block[1].matchAll(/'([a-z_][a-z0-9_]*)'/g)].map(m => m[1]);
}

describe('MDF §5.7b cutover fence covers every table the read-path loaders touch', () => {
  it('every FROM/JOIN table in the reconciliation/shadow loaders and the demand query is fenced by migration 195', () => {
    const migration195 = read('db/migrations/195_mdf_baseline_population.sql');
    // §5.8: migration 199 extends the list (cut_result_archive_state).
    const migration199 = read('db/migrations/199_mdf_cutover_controls.sql');
    const fenced = new Set([...extractFenceTableList(migration195), ...extractFenceTableList(migration199)]);
    expect(fenced.size).toBeGreaterThan(30);

    const reconciliationInventory = read('src/modules/mdf-board/adapters/mdf-reconciliation-inventory.ts');
    const shadowProofLoader = read('src/modules/mdf-board/adapters/mdf-shadow-proof-loader.ts');
    const shadowSource = read('src/modules/mdf-board/adapters/mdf-shadow-source.ts');
    const executionSnapshot = read('src/modules/mdf-board/adapters/mdf-execution-snapshot.ts');
    // "The demand query": `loadMdfExecutionDetails` alone (the live-demand digest source consumed by
    // `loadMdfClosedOrders`), not the whole execution-snapshot module (which also reads sealed engine revisions).
    const demandQueryStart = executionSnapshot.indexOf('export async function loadMdfExecutionDetails');
    const demandQueryEnd = executionSnapshot.indexOf('export async function loadMdfExecutionSnapshot');
    expect(demandQueryStart).toBeGreaterThan(-1);
    expect(demandQueryEnd).toBeGreaterThan(demandQueryStart);
    const demandQuery = executionSnapshot.slice(demandQueryStart, demandQueryEnd);

    const touched = new Set<string>();
    for (const source of [reconciliationInventory, shadowProofLoader, shadowSource, demandQuery]) {
      for (const table of extractTables(source)) touched.add(table);
    }
    // Sanity: the extraction actually found the real tables these files are known to read (guards against the
    // regex silently matching nothing after a refactor).
    expect([...touched]).toEqual(expect.arrayContaining(['order_details', 'orders', 'cnc_telegram_packets',
      'bazis_cut_sets', 'cut_result', 'mdf_shadow_commands', 'mdf_evidence_lines']));

    const unfenced = [...touched].filter(t => !EXCLUDED_TABLES.has(t) && !fenced.has(t)).sort();
    expect(unfenced).toEqual([]);
  });
});
