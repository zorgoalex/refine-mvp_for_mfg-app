import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('216 1C consumption documents migration', () => {
  const sql = readFileSync(new URL('./216_onec_consumption_documents.sql', import.meta.url), 'utf8');
  const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

  it('adds consumption kinds and additive columns without touching rows', () => {
    for (const column of ['time_zone', 'doc_at', 'operation_kind', 'warehouse_ref_key', 'destination_warehouse_ref_key', 'normalizer_version', 'is_stock_item', 'unit_is_package']) {
      expect(sql).toContain(`ADD COLUMN IF NOT EXISTS ${column}`);
    }
    for (const kind of ['sales_shipment', 'supplier_return', 'inventory_writeoff', 'inventory_transfer']) expect(sql).toContain(`'${kind}'`);
    expect(sql).toContain("DEFAULT 'Asia/Almaty'");
    expect(sql).toContain('ALTER COLUMN currency DROP NOT NULL');
    expect(sql).toContain('chk_onec_documents_currency_kind');
    expect(sql).not.toMatch(/^\s*(UPDATE|DELETE|INSERT)\s+/im);
    // Единственный DROP — прежний CHECK видов, заменяемый chk_onec_documents_kind_v2 (новое имя — проба не срабатывает до применения).
    expect(sql.match(/\bDROP\b/gi)).toHaveLength(2);
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS chk_onec_documents_kind;');
  });

  it('probes the new objects before recording the ledger', () => {
    expect(runner).toContain('216_onec_consumption_documents*) probe_all');
    expect(runner).toContain('q_con_on onec_documents chk_onec_documents_kind_v2');
    expect(runner).toContain('q_col onec_documents doc_at');
    expect(runner).toContain('q_col onec_sources time_zone');
    const verify = runner.slice(runner.indexOf('verify_applied_effect() {'));
    expect(verify).toMatch(/216_onec_consumption_documents\*\)\s+probe_file "\$f" \|\| die/);
  });
});
