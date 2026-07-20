import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./075_order_detail_reference_names.sql', import.meta.url), 'utf8');
const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

describe('075_order_detail_reference_names migration', () => {
  it('exposes milling and film names beside their reference ids', () => {
    expect(sql).toMatch(/CREATE OR REPLACE VIEW order_details_view AS/i);
    expect(sql).toMatch(/od\.milling_type_id/i);
    expect(sql).toMatch(/mt\.milling_type_name/i);
    expect(sql).toMatch(/LEFT JOIN milling_types mt ON mt\.milling_type_id = od\.milling_type_id/i);
    expect(sql).toMatch(/od\.film_id/i);
    expect(sql).toMatch(/f\.film_name/i);
    expect(sql).toMatch(/LEFT JOIN films f ON f\.film_id = od\.film_id/i);
  });

  it('preserves the current order detail view columns', () => {
    expect(sql).toMatch(/smt\.name AS material_name/i);
    expect(sql).toMatch(/od\.basis_designation/i);
    expect(sql).toMatch(/od\.basis_product/i);
    expect(sql).toMatch(/od\.doweling/i);
  });

  it('moves every supported saved binding from ids to display names', () => {
    expect(sql).toMatch(/UPDATE label_template_elements/i);
    expect(sql).toMatch(/source_field[\s\S]*detail\.milling_type_name/i);
    expect(sql).toMatch(/style_json[\s\S]*qrTemplate[\s\S]*detail\.milling_type_name/i);
    expect(sql).toMatch(/condition_json[\s\S]*detail\.milling_type_name/i);
    expect(sql).toMatch(/custom_field_schema[\s\S]*sourceField[\s\S]*detail\.milling_type_name/i);
    expect(sql).toMatch(/content_template[\s\S]*detail\.milling_type_name/i);
    expect(sql).toMatch(/custom_field_schema_snapshot[\s\S]*detail\.milling_type_name/i);
    expect(sql).toMatch(/source_field[\s\S]*detail\.film_name/i);
    expect(sql).toMatch(/style_json[\s\S]*qrTemplate[\s\S]*detail\.film_name/i);
    expect(sql).toMatch(/condition_json[\s\S]*detail\.film_name/i);
    expect(sql).toMatch(/custom_field_schema[\s\S]*sourceField[\s\S]*detail\.film_name/i);
    expect(sql).toMatch(/content_template[\s\S]*detail\.film_name/i);
    expect(sql).toMatch(/custom_field_schema_snapshot[\s\S]*detail\.film_name/i);
    expect(sql).toMatch(/version\s*=\s*lt\.version\s*\+\s*1/i);
    expect(sql).toMatch(/version\s*=\s*lqt\.version\s*\+\s*1/i);
    expect(sql).toMatch(/field_catalog_snapshot/i);
  });

  it('selects affected ids before rewriting so reruns do not bump versions again', () => {
    expect(sql).toMatch(/CREATE TEMP TABLE label_reference_name_affected_templates[\s\S]*ON COMMIT DROP/i);
    expect(sql).toMatch(/CREATE TEMP TABLE label_reference_name_affected_qr_templates[\s\S]*ON COMMIT DROP/i);
    expect(sql).toMatch(/FROM label_reference_name_affected_templates affected/i);
    expect(sql).toMatch(/FROM label_reference_name_affected_qr_templates affected/i);
  });

  it('requires the complete data end-state before auto mode marks 075 present', () => {
    expect(runner).toMatch(/075_\*\)\s*probe_075_endstate/);
    const probe = runner.slice(
      runner.indexOf('probe_075_endstate()'),
      runner.indexOf('# 003 policy probe'),
    );
    expect(probe).toMatch(/label_template_elements[\s\S]*source_field/i);
    expect(probe).toMatch(/style_json->>'qrTemplate'/i);
    expect(probe).toMatch(/condition_json->>'field'/i);
    expect(probe).toMatch(/label_templates[\s\S]*custom_field_schema/i);
    expect(probe).toMatch(/label_qr_templates[\s\S]*content_template/i);
    expect(probe).toMatch(/order_label_detail_data[\s\S]*custom_field_schema_snapshot/i);
    expect(probe).toMatch(/field_catalog_snapshot/i);
    expect(probe).toMatch(/SELECT NOT EXISTS/i);
  });

  it('does not contain destructive data operations', () => {
    expect(sql).not.toMatch(/DROP COLUMN/i);
    expect(sql).not.toMatch(/DROP TABLE/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
  });
});
