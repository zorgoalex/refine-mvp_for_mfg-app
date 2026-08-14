import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./128_order_detail_hdf_parameter_override.sql', import.meta.url), 'utf8');
const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

describe('128_order_detail_hdf_parameter_override migration', () => {
  it('adds a nullable positive HDF parameter override to order details', () => {
    expect(sql).toMatch(/ALTER TABLE order_details\s+ADD COLUMN IF NOT EXISTS hdf_parameter_override_mm NUMERIC\(10,2\)/i);
    expect(sql).toContain('chk_order_details_hdf_parameter_override_mm');
    expect(sql).toMatch(/hdf_parameter_override_mm IS NULL OR hdf_parameter_override_mm > 0/i);
  });

  it('is idempotent and documented', () => {
    expect(sql).toMatch(/BEGIN;/i);
    expect(sql).toMatch(/IF NOT EXISTS/i);
    expect(sql).toMatch(/COMMENT ON COLUMN order_details\.hdf_parameter_override_mm/i);
    expect(sql).toMatch(/COMMIT;/i);
  });

  it('neutralizes the legacy auto HDF parameter name without touching custom names', () => {
    expect(sql).toMatch(/UPDATE milling_type_extra_resources/i);
    expect(sql).toContain("parameter_name = 'Параметр'");
    expect(sql).toContain("parameter_name = 'Отступ от края'");
    expect(sql).toContain('hdf_auto_enabled = true');
  });

  it('is classified by the migration runner probe map', () => {
    expect(runner).toContain('128_order_detail_hdf_parameter_override*) probe_all');
    expect(runner).toContain('order_details hdf_parameter_override_mm');
    expect(runner).toContain('chk_order_details_hdf_parameter_override_mm');
    expect(runner).toContain('128_*');
  });
});
