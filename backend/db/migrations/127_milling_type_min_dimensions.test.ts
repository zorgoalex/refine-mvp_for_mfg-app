import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./127_milling_type_min_dimensions.sql', import.meta.url), 'utf8');

describe('migration 127 milling type minimum dimensions', () => {
  it('adds optional width and height limits', () => {
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS min_width_mm integer/i);
    expect(sql).toMatch(/ADD COLUMN IF NOT EXISTS min_height_mm integer/i);
  });

  it('accepts null and rejects non-positive limits', () => {
    expect(sql).toMatch(/CHECK \(min_width_mm IS NULL OR min_width_mm > 0\)/i);
    expect(sql).toMatch(/CHECK \(min_height_mm IS NULL OR min_height_mm > 0\)/i);
  });
});
