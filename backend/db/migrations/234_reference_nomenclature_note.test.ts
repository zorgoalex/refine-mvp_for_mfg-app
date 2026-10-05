import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('234 reference nomenclature and note migration', () => {
  const sql = readFileSync(new URL('./234_reference_nomenclature_note.sql', import.meta.url), 'utf8');
  const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

  it('adds nullable bounded columns to sheet materials and catalog items idempotently, without data changes', () => {
    for (const table of ['sheet_material_types', 'catalog_items']) {
      expect(sql).toMatch(new RegExp(`ALTER TABLE public\\.${table}\\s+ADD COLUMN IF NOT EXISTS nomenclature_type VARCHAR\\(50\\) NULL,\\s+ADD COLUMN IF NOT EXISTS nomenclature_category VARCHAR\\(150\\) NULL,\\s+ADD COLUMN IF NOT EXISTS note TEXT NULL;`));
      expect(sql).toContain(`ADD CONSTRAINT chk_${table}_note_length CHECK (note IS NULL OR length(note) <= 2000)`);
    }
    expect(sql).not.toMatch(/^\s*(UPDATE|DELETE|INSERT)\s+/im);
    expect(sql).not.toMatch(/\bDROP\b/i);
  });

  it('probes every column and check before recording the ledger', () => {
    expect(runner).toContain('234_reference_nomenclature_note*) probe_all');
    for (const table of ['sheet_material_types', 'catalog_items']) {
      for (const column of ['nomenclature_type', 'nomenclature_category', 'note']) expect(runner).toContain(`q_col ${table} ${column}`);
      expect(runner).toContain(`q_con_on ${table} chk_${table}_note_length`);
    }
    const verify = runner.slice(runner.indexOf('verify_applied_effect() {'));
    expect(verify).toContain('234_reference_nomenclature_note*');
  });
});
