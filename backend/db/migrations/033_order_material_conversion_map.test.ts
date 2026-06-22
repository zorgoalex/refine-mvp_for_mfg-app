// backend/db/migrations/033_order_material_conversion_map.test.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  join(__dirname, '033_order_material_conversion_map.sql'),
  'utf8',
);

describe('migration 033 — committed conversion manifest', () => {
  it('wraps in a single transaction', () => {
    expect(sql).toMatch(/^\s*BEGIN;/);
    expect(sql.trimEnd()).toMatch(/COMMIT;\s*$/);
  });

  it('creates sheet_material_conversion_map table', () => {
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS sheet_material_conversion_map/i);
  });

  it('adds conversion_key column to sheet_material_types', () => {
    expect(sql).toMatch(/ALTER TABLE sheet_material_types\s+ADD COLUMN IF NOT EXISTS conversion_key/i);
  });

  it('adds is_cuttable column to sheet_material_types', () => {
    expect(sql).toMatch(/ALTER TABLE sheet_material_types\s+ADD COLUMN IF NOT EXISTS is_cuttable BOOLEAN/i);
  });

  it('seeds the manifest with the panel material entries (by legacy_material_id)', () => {
    expect(sql).toMatch(/INSERT INTO sheet_material_conversion_map/);
    expect(sql).toMatch(/'ROUGH_MDF_16'/);
    expect(sql).toMatch(/'MDF_10'/);
    expect(sql).toMatch(/'PLYWOOD'/);
  });

  it('seeds non-cuttable entries by legacy_material_name', () => {
    expect(sql).toMatch(/'PAINT'/);
    // The manifest row for 'краска'/'PAINT' passes false as the is_cuttable value
    // Column order: (legacy_material_name, target_key, target_sheet_name, is_cuttable, ...)
    // → ('краска', 'PAINT', 'краска', false, ...)
    expect(sql).toMatch(/'краска',\s*false/);
  });

  it('performs a full-replace DELETE before INSERT (re-runnable)', () => {
    expect(sql).toMatch(/DELETE FROM sheet_material_conversion_map;/);
    // DELETE must precede the INSERT
    expect(sql.indexOf('DELETE FROM sheet_material_conversion_map')).toBeLessThan(
      sql.indexOf('INSERT INTO sheet_material_conversion_map'),
    );
  });

  it('asserts no target_key has inconsistent attrs across manifest rows', () => {
    expect(sql).toMatch(/RAISE EXCEPTION.*manifest.*target_key.*inconsistent/i);
  });

  it('reconciles existing sheet_material_types structural attrs from manifest', () => {
    expect(sql).toMatch(/UPDATE sheet_material_types s\s+SET unit_id/i);
    expect(sql).toMatch(/material_type_id\s+=\s+mk\.target_material_type_id/);
    expect(sql).toMatch(/is_cuttable\s+=\s+mk\.is_cuttable/);
  });
});
