import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./131_cut_render_style_templates.sql', import.meta.url), 'utf8');
const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

describe('131_cut_render_style_templates migration', () => {
  it('wraps the existing MDF render profile into an editable template catalog', () => {
    expect(sql).toContain("WHERE key = 'render.styles'");
    expect(sql).toContain("'defaultProfileId'");
    expect(sql).toContain("'templates'");
    expect(sql).toContain("'mdf_board_preview'");
    expect(sql).toContain("'MDF-превью'");
    expect(sql).toContain("value #> '{profiles,mdf_board_preview}'");
  });

  it('is classified by the migration runner probe map', () => {
    expect(runner).toContain('131_cut_render_style_templates*) probe_all');
    expect(runner).toContain("value->>'defaultProfileId' = 'mdf_board_preview'");
    expect(runner).toContain('131_*');
  });
});
