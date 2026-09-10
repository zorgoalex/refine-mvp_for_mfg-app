import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
describe('catalog reference service fields migration', () => {
  it('adds common UUID/sort fields without rewriting audit metadata', () => {
    const sql = readFileSync(new URL('./161_catalog_reference_service_fields.sql', import.meta.url), 'utf8');
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS ref_key_1c uuid');
    expect(sql).toContain('sort_order smallint NOT NULL DEFAULT 100');
    expect(sql).not.toMatch(/DROP|UPDATE public|ADD COLUMN.*(?:created_by|is_active)/i);
    const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');
    expect(runner).toContain('161_catalog_reference_service_fields*) probe_all');
    expect(runner).toContain('|161_*)');
  });
});
