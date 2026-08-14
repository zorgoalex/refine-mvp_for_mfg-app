import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./129_cut_render_styles.sql', import.meta.url), 'utf8');
const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

describe('129_cut_render_styles migration', () => {
  it('seeds an editable render.styles setting with the MDF board preview profile', () => {
    expect(sql).toMatch(/INSERT INTO cut_settings \(key, value\)/i);
    expect(sql).toContain("'render.styles'");
    expect(sql).toContain('"mdf_board_preview"');
    expect(sql).toContain('"minStrokePx": 2.75');
    expect(sql).toContain('"fillStrategy": "contrast"');
  });

  it('does not overwrite an existing render.styles row', () => {
    expect(sql).toMatch(/ON CONFLICT \(key\) DO NOTHING/i);
  });

  it('is classified by the migration runner probe map', () => {
    expect(runner).toContain('129_cut_render_styles*) probe_all');
    expect(runner).toContain("key = 'render.styles'");
    expect(runner).toContain('129_*');
  });
});
