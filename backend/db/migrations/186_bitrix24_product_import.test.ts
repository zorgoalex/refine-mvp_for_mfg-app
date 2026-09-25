import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { expectMigrationEffectGate } from '../../test-support/migration-runner';

describe('Bitrix24 product import additive migration and runner', () => {
  const sql = readFileSync(new URL('./186_bitrix24_product_import.sql', import.meta.url), 'utf8');
  const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');
  it('is additive and never claims existing requests are product-synced', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.bitrix24_product_mapping');
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.bitrix24_product_row_snapshot');
    expect(sql).toContain("product_sync_status text NOT NULL DEFAULT 'pending'");
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS');
    expect(sql).not.toMatch(/UPDATE\s+(?:public\.)?orders\s+SET/i);
    expect(sql).not.toMatch(/UPDATE\s+(?:public\.)?bitrix24_incoming_request\s+SET/i);
    expect(sql).not.toMatch(/INSERT\s+INTO\s+(?:public\.)?bitrix24_product_mapping/i);
  });
  it('keeps remote row identity explicit and the final row price unchanged', () => {
    expect(sql).toContain("bitrix_row_id ~ '^[1-9][0-9]*$'");
    expect(sql).toContain("bitrix_product_id ~ '^[1-9][0-9]*$'");
    expect(sql).toContain('PRIMARY KEY (request_id, bitrix_row_id)');
    expect(sql).toContain('REFERENCES public.catalog_items(id)');
    expect(sql).toContain('REFERENCES public.order_catalog_lines(id)');
    expect(sql).toContain('uq_bitrix24_product_row_snapshot_line');
  });
  it('probes every new table, request column, constraint and index before recording the ledger', () => {
    expect(runner).toContain('186_bitrix24_product_import*) probe_all');
    expect(runner).toContain('q_tbl bitrix24_product_mapping');
    expect(runner).toContain('q_tbl bitrix24_product_row_snapshot');
    expect(runner).toContain('q_col bitrix24_incoming_request product_sync_status');
    expect(runner).toContain('q_col bitrix24_incoming_request product_rows_hash');
    expect(runner).toContain('q_col bitrix24_incoming_request product_order_fingerprint');
    expect(runner).toContain('q_con_on bitrix24_incoming_request chk_bitrix24_request_product_sync');
    expect(runner).toContain('q_idx uq_bitrix24_product_row_snapshot_line');
    const verify = runner.slice(runner.indexOf('verify_applied_effect() {'));
    expect(verify).toMatch(/186_bitrix24_product_import\*\)\s+probe_file "\$f" \|\| die/);
  });
  it('runner effect gate records only after the probe passes', () => {
    expectMigrationEffectGate(runner, '186_bitrix24_product_import.sql');
  });
});
