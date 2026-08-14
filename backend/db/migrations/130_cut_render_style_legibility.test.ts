import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./130_cut_render_style_legibility.sql', import.meta.url), 'utf8');
const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

describe('130_cut_render_style_legibility migration', () => {
  it('updates the MDF render profile for readable pastel milling and strong labels', () => {
    expect(sql).toContain("WHERE key = 'render.styles'");
    expect(sql).toContain('"strokeWidthMm": 1.6');
    expect(sql).toContain('"minStrokePx": 1.6');
    expect(sql).toContain('"strokeColorMode": "piece-pastel"');
    expect(sql).toContain('"darkTextStroke": "#ffffff"');
    expect(sql).toContain('"fontWeight": 800');
  });

  it('is classified by the migration runner probe map', () => {
    expect(runner).toContain('130_cut_render_style_legibility*) probe_all');
    expect(runner).toContain("value #>> '{profiles,mdf_board_preview,sourceSvg,strokeColorMode}' = 'piece-pastel'");
    expect(runner).toContain('130_*');
  });
});
