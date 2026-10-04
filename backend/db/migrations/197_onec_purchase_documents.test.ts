import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { expectMigrationEffectGate } from '../../test-support/migration-runner';

describe('197 1C purchase documents migration', () => {
  const sql = readFileSync(new URL('./197_onec_purchase_documents.sql', import.meta.url), 'utf8');
  const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

  it('is additive: three new empty tables, nothing existing is changed', () => {
    for (const table of ['onec_documents', 'onec_document_lines', 'order_resource_onec_allocations']) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS public.${table}`);
    }
    expect(sql).not.toMatch(/\bUPDATE\s+/i);
    expect(sql).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(sql).not.toMatch(/\bALTER\s+TABLE\b/i);
    expect(sql).not.toMatch(/\bDROP\b/i);
  });

  it('keys documents per 1C source and never cascades deletions', () => {
    expect(sql).toContain('REFERENCES public.onec_sources(source_id)');
    expect(sql).toContain('UNIQUE (source_id, doc_kind, onec_ref_key)');
    expect(sql).not.toMatch(/ON DELETE CASCADE/i);
  });

  it('allocates receipts by quantity and payments by amount, both strictly positive', () => {
    expect(sql).toContain("(role = 'receipt' AND quantity IS NOT NULL AND amount IS NULL)");
    expect(sql).toContain("(role = 'payment' AND amount IS NOT NULL AND quantity IS NULL)");
    expect(sql).toContain('CHECK (quantity IS NULL OR quantity > 0)');
    expect(sql).toContain('CHECK (amount IS NULL OR amount > 0)');
    expect(sql).toMatch(/uq_orp_alloc_active[\s\S]*WHERE removed_at IS NULL/);
    expect(sql).toContain('CHECK (sheet_material_type_id IS NULL OR film_id IS NULL)');
    expect(sql).toMatch(/uq_onec_document_lines_total[\s\S]*WHERE is_document_total/);
  });

  it('probes every table, constraint and index before recording the ledger', () => {
    expect(runner).toContain('197_onec_purchase_documents*) probe_all');
    for (const table of ['onec_documents', 'onec_document_lines', 'order_resource_onec_allocations']) {
      expect(runner).toContain(`q_tbl ${table}`);
    }
    for (const name of ['chk_onec_documents_kind', 'uq_onec_documents_ref', 'chk_onec_document_lines_one_material',
      'chk_orp_alloc_measure', 'chk_orp_alloc_role']) {
      expect(runner).toContain(name);
    }
    for (const index of ['idx_onec_documents_kind_date', 'uq_onec_document_lines_total', 'uq_orp_alloc_active', 'idx_orp_alloc_line_active', 'idx_orp_alloc_procurement']) {
      expect(runner).toContain(`q_idx ${index}`);
    }
    const verify = runner.slice(runner.indexOf('verify_applied_effect() {'));
    expect(verify).toMatch(/197_onec_purchase_documents\*\)\s+probe_file "\$f" \|\| die/);
  });

  it('runner effect gate records only after the probe passes', () => {
    expectMigrationEffectGate(runner, '197_onec_purchase_documents.sql');
  });
});
