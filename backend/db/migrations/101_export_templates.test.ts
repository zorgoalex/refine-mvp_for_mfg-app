import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(resolve(__dirname, '101_export_templates.sql'), 'utf8');

describe('101_export_templates.sql', () => {
  it('creates a versioned JSON aggregate with one-active-default uniqueness', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS export_templates');
    expect(sql).toContain('schema_version SMALLINT');
    expect(sql).toContain('columns_json JSONB');
    expect(sql).toContain('uq_export_templates_active_default');
  });

  it('seeds both backward-compatible default targets', () => {
    expect(sql).toContain('bazis-cut-set-standard-v1');
    expect(sql).toContain('bazis-project-cut-standard-v1');
    expect(sql).toContain("'Детали для раскроя'");
    expect(sql.match(/\"columnKey\"/g)).toHaveLength(37);
  });
});
