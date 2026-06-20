import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(__dirname, '../../db/migrations/030_order_detail_shadow_pairing_trigger.sql'),
  'utf8',
);

describe('030 order_detail shadow-pairing trigger migration text', () => {
  it('defines an idempotent BEFORE INSERT/UPDATE trigger on order_details', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION assert_order_detail_shadow_pairing');
    expect(sql).toContain('DROP TRIGGER IF EXISTS trg_order_detail_shadow_pairing ON order_details');
    expect(sql).toMatch(/BEFORE INSERT OR UPDATE[\s\S]*ON order_details/);
  });

  it('enforces shadow pairing: shadow material_id requires the matching sheet id', () => {
    expect(sql).toContain('is_sheet_shadow');
    expect(sql).toContain('shadow_of_sheet_material_type_id');
    expect(sql).toMatch(/sheet_material_type_id IS NULL/);
    expect(sql).toMatch(/RAISE EXCEPTION/);
    expect(sql).toContain("ERRCODE = 'check_violation'");
  });

  it('leaves legacy (non-shadow) rows untouched', () => {
    // NULL material_id short-circuits; only is_sheet_shadow rows are constrained
    expect(sql).toMatch(/IF NEW\.material_id IS NULL THEN[\s\S]*RETURN NEW/);
    expect(sql).toMatch(/IF v_is_shadow IS TRUE THEN/);
  });

  it('documents a reversible down section', () => {
    expect(sql).toContain('DROP FUNCTION IF EXISTS assert_order_detail_shadow_pairing');
  });
});
