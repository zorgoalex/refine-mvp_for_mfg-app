import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./100_bazis_cut_product_bath_export.sql', import.meta.url), 'utf8');

describe('100 Basis-cut product and bath export migration', () => {
  it('adds a non-null frozen bath number and backfills the latest ready vacuum result', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS source_bath_cut_number TEXT NOT NULL DEFAULT ''/i);
    expect(sql).toMatch(/WITH RECURSIVE ancestry[\s\S]*source_bazis_node_id[\s\S]*node_kind = 'product'/i);
    expect(sql).toMatch(/SET source_bazis_product_name = product\.product_name/i);
    expect(sql).toMatch(/COALESCE\([\s\S]*cj\.last_calc_params->>'layout_mode'[\s\S]*profile\.params->>'layout_mode'[\s\S]*cj\.params->>'layout_mode'[\s\S]*\)\s*=\s*'vacuum_table'/i);
    expect(sql).toMatch(/row_number\(\) OVER \([\s\S]*ORDER BY cj\.cut_job_id DESC/i);
    expect(sql).toMatch(/candidate\.cut_job_id::text \|\| '-' \|\| candidate\.result_no::text/i);
    expect(sql).toContain('bazis-cut-bath-number-v1');
  });

  it('is transactional and non-destructive', () => {
    expect(sql).toContain('BEGIN;');
    expect(sql).toContain('COMMIT;');
    expect(sql).not.toMatch(/\b(?:DELETE|DROP|TRUNCATE)\b/i);
  });
});
