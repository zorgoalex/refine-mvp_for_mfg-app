// backend/db/migrations/034_order_material_sunset_legacy.test.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(
  join(__dirname, '034_order_material_sunset_legacy.sql'),
  'utf8',
);

describe('migration 034 — sunset legacy order material link', () => {
  it('wraps in a single transaction', () => {
    expect(sql).toMatch(/^\s*BEGIN;/);
    expect(sql.trimEnd()).toMatch(/COMMIT;\s*$/);
  });
  it('makes order_details.material_id nullable', () => {
    expect(sql).toMatch(/ALTER TABLE order_details\s+ALTER COLUMN material_id DROP NOT NULL/i);
  });
  it('nulls order material_id and deletes shadows', () => {
    expect(sql).toMatch(/UPDATE order_details[\s\S]*SET material_id = NULL/i);
    expect(sql).toMatch(/DELETE FROM materials\s+WHERE is_sheet_shadow = true/i);
  });
  it('drives conversion from the committed manifest table, not inline hard-coded ids', () => {
    expect(sql).toMatch(/sheet_material_conversion_map/);
    expect(sql).not.toMatch(/VALUES\s*\(\s*0,\s*'не определён'/); // no inline id->name map
    expect(sql).toMatch(/CREATE TEMP TABLE _matmap/);
    expect(sql).toMatch(/UPDATE order_details[\s\S]*SET sheet_material_type_id = mm\.sid/);
  });
  it('fails closed if the 033 manifest table is absent (Critic R12 B1)', () => {
    expect(sql).toMatch(/information_schema\.tables WHERE table_name = 'sheet_material_conversion_map'[\s\S]*RAISE EXCEPTION/i);
  });
  it('flips sheet_eligible=true for converted orders (Critic R4 B1)', () => {
    expect(sql).toMatch(/UPDATE orders[\s\S]*SET sheet_eligible = true/i);
  });
  it('guards dual-populated rows whose material_id maps to a different sheet (Critic R10 B1)', () => {
    expect(sql).toMatch(/dual-populated mismatch/i);
    expect(sql).toMatch(/sheet_material_type_id <> mm\.sid/);
  });
  it('aborts when a legacy material maps to multiple sheet types (Critic R11 B1)', () => {
    expect(sql).toMatch(/GROUP BY mid HAVING count\(DISTINCT sid\) > 1/);
  });
  it('creates target types from manifest attrs, not hardcoded material_type_id/thickness (Critic R10 B2)', () => {
    expect(sql).toMatch(/t\.target_material_type_id/);
    expect(sql).toMatch(/t\.target_thickness_mm/);
    expect(sql).not.toMatch(/material_type_id,\s*\n?\s*1::smallint, 3::smallint/);
  });
  it('derives FK referrers from pg_constraint before deleting shadows (Critic R5 B2 / R27 B1)', () => {
    // dynamic guard over pg_constraint (catches sheet_material_links + any future FK)
    expect(sql).toMatch(/pg_constraint[\s\S]*confrelid = 'materials'::regclass/);
    expect(sql).toMatch(/EXECUTE format\([\s\S]*WHERE m\.is_sheet_shadow/);
    // guard precedes the DELETE
    expect(sql.indexOf('confrelid = ')).toBeLessThan(sql.indexOf('DELETE FROM materials WHERE is_sheet_shadow'));
  });
  it('aborts on an unmapped detail OR an unmapped header material', () => {
    expect(sql).toMatch(/order_details[\s\S]*sheet_material_type_id IS NULL[\s\S]*RAISE EXCEPTION/i);
    expect(sql).toMatch(/orders[\s\S]*material_id IS NOT NULL AND[\s\S]*sheet_material_type_id IS NULL[\s\S]*RAISE EXCEPTION/i);
  });
  it('drops the 030 pairing trigger and the orders XOR check', () => {
    expect(sql).toMatch(/DROP TRIGGER IF EXISTS trg_order_detail_shadow_pairing/i);
    expect(sql).toMatch(/DROP CONSTRAINT IF EXISTS chk_orders_sheet_xor_material/i);
  });
  it('adds sheet-only invariants', () => {
    expect(sql).toMatch(/order_details\s+ALTER COLUMN sheet_material_type_id SET NOT NULL/i);
    expect(sql).toMatch(/chk_orders_material_id_null/i);
  });
  it('rebuilds views without the material_name COALESCE fallback', () => {
    expect(sql).toMatch(/CREATE OR REPLACE VIEW order_details_view/i);
    expect(sql).toMatch(/CREATE OR REPLACE VIEW orders_view/i);
  });
  it('rebuilds every other material-deriving view (Critic R6 B1)', () => {
    for (const v of ['doweling_orders_view','orders_alias_view','details_of_order']) {
      expect(sql).toMatch(new RegExp(`CREATE OR REPLACE VIEW ${v}`, 'i'));
    }
    // Critic R16 M3: strip SQL comments first so the assertion tests SQL semantics,
    // not comment wording (comments in this migration mention "LEFT JOIN materials").
    const noComments = sql.replace(/--[^\n]*/g, '');
    const viewsBlock = noComments.slice(noComments.indexOf('CREATE OR REPLACE VIEW order_details_view'));
    expect(viewsBlock).not.toMatch(/LEFT JOIN materials/i);
  });
});
