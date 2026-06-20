import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sql = readFileSync(
  join(__dirname, '../../db/migrations/029_order_sheet_material_type.sql'),
  'utf8',
);

describe('029 order sheet material type migration text', () => {
  it('is additive and idempotent', () => {
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS sheet_material_type_id');
    expect(sql).toContain('fk_order_details_sheet_material_type');
    expect(sql).toContain('fk_orders_sheet_material_type');
    expect(sql).toContain('ON DELETE RESTRICT');
    expect(sql).toContain('COALESCE(smt.name, m.material_name) AS material_name');
    expect(sql).toContain('CREATE OR REPLACE VIEW order_details_view');
    expect(sql).toContain('uq_materials_shadow_of_sheet_material_type_id');
    expect(sql).toContain('shadow_of_sheet_material_type_id');
    expect(sql).toContain('is_sheet_shadow');
    expect(sql).toContain('chk_orders_sheet_xor_material');
    expect(sql).toContain('chk_materials_shadow_shape');
    expect(sql).toContain('sheet_eligible');
    // regression guard: orders_view rebuild must NOT drop ord.version (added by migr 004)
    expect(sql).toContain('ord.version');
    // preserve the view's final ordering
    expect(sql).toContain('ORDER BY ord.order_id DESC');
    expect(sql).not.toMatch(/ALTER TABLE order_details[\s\S]*ALTER COLUMN material_id/i);
  });
});
