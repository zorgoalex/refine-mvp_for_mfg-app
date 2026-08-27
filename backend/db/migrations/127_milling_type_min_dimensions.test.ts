import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./127_milling_type_min_dimensions.sql', import.meta.url), 'utf8');
const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

describe('migration 127 milling type minimum dimensions', () => {
  it('adds optional width and height limits', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS min_width_mm integer/i);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS min_height_mm integer/i);
  });

  it('accepts null and rejects non-positive limits', () => {
    expect(sql).toMatch(/CHECK \(min_width_mm IS NULL OR min_width_mm > 0\)/i);
    expect(sql).toMatch(/CHECK \(min_height_mm IS NULL OR min_height_mm > 0\)/i);
  });

  it('has a runner end-state probe', () => {
    expect(runner).toContain('127_milling_type_min_dimensions*) probe_all');
    expect(runner).toContain('q_col milling_types min_width_mm');
    expect(runner).toContain('q_col milling_types min_height_mm');
    expect(runner).toContain('q_con_on milling_types chk_milling_types_min_width_mm');
    expect(runner).toContain('q_con_on milling_types chk_milling_types_min_height_mm');
  });
});
