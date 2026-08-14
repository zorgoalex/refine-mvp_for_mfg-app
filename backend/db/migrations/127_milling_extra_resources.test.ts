import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./127_milling_extra_resources.sql', import.meta.url), 'utf8');
const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

describe('127_milling_extra_resources migration', () => {
  it('adds a flexible extra resources table for milling types', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS milling_type_extra_resources/i);
    expect(sql).toMatch(/milling_type_id SMALLINT NOT NULL REFERENCES milling_types\(milling_type_id\) ON DELETE CASCADE/i);
    expect(sql).toMatch(/resource_kind TEXT NOT NULL DEFAULT 'other'/i);
    expect(sql).toMatch(/resource_name TEXT NOT NULL DEFAULT ''/i);
    expect(sql).toMatch(/unit_id SMALLINT REFERENCES units\(unit_id\) ON DELETE SET NULL/i);
    expect(sql).toMatch(/accounting_method TEXT NOT NULL DEFAULT ''/i);
    expect(sql).toMatch(/parameter_name TEXT NOT NULL DEFAULT ''/i);
    expect(sql).toMatch(/parameter_mm NUMERIC\(10,2\)/i);
  });

  it('keeps HDF as a configurable auto resource without dropping legacy columns', () => {
    expect(sql).toMatch(/hdf_auto_enabled BOOLEAN NOT NULL DEFAULT false/i);
    expect(sql).toMatch(/idx_milling_type_extra_resources_hdf_auto/i);
    expect(sql).toContain('WHERE mt.hdf_enabled = true');
    expect(sql).toContain('mt.hdf_edge_mm');
    expect(sql).toContain("'Отступ от края'");
    expect(sql).not.toMatch(/DROP COLUMN IF EXISTS hdf_enabled/i);
    expect(sql).not.toMatch(/DROP COLUMN IF EXISTS hdf_edge_mm/i);
  });

  it('is idempotent and transactional', () => {
    expect(sql).toMatch(/BEGIN;/i);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS/i);
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS/i);
    expect(sql).toMatch(/AND NOT EXISTS/i);
    expect(sql).toMatch(/COMMIT;/i);
  });

  it('is classified by the migration runner probe map', () => {
    expect(runner).toContain('127_milling_extra_resources*) probe_all');
    expect(runner).toContain('milling_type_extra_resources hdf_auto_enabled');
    expect(runner).toContain('127_*');
  });
});
