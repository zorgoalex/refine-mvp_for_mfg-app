import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./120_cnc_manual_svg_comment_preset_seed.sql', import.meta.url), 'utf8');
const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

describe('120_cnc_manual_svg_comment_preset_seed migration', () => {
  it('adds operator comment presets for manual SVG uploads', () => {
    expect(sql).toContain("('Фрезы ХДФ', 'Фрезы для ХДФ: 8', 'tool', 60)");
    expect(sql).toContain("('Черновой с двух сторон', 'Черновой с двух сторон!!!', 'general', 70)");
    expect(sql).toContain("('Присадка №', 'Присадка №', 'general', 80)");
    expect(sql).toContain("('Фрезы 18мм', 'Фрезы для 18мм:', 'tool', 90)");
    expect(sql).toContain("('Фрезы ЛДСП', 'Фрезы для ЛДСП: 8', 'tool', 110)");
    expect(sql).toContain("('Фреза ламинированной стороны', 'Фреза для ламинированной стороны:', 'tool', 140)");
    expect(sql).toContain('ON CONFLICT DO NOTHING');
  });

  it('is classified by the migration runner probe map', () => {
    expect(runner).toContain('120_cnc_manual_svg_comment_preset_seed*) probe_all');
    expect(runner).toContain("lower(trim(comment_text)) = lower('Фрезы для ХДФ: 8')");
    expect(runner).toContain('120_*');
  });
});
