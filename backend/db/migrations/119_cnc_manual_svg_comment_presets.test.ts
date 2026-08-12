import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./119_cnc_manual_svg_comment_presets.sql', import.meta.url), 'utf8');
const runner = readFileSync(new URL('../../../ops/apply-migrations.sh', import.meta.url), 'utf8');

describe('119_cnc_manual_svg_comment_presets migration', () => {
  it('creates active unique preset catalog with seed rows', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS cnc_manual_svg_comment_presets');
    expect(sql).toContain('uq_cnc_manual_svg_comment_presets_active_text');
    expect(sql).toContain("category IN ('general', 'order', 'tool', 'material', 'rework', 'custom')");
    expect(sql).toContain("('Весь заказ', 'весь заказ', 'order', 10)");
    expect(sql).toContain("('Переделка', 'переделка', 'rework', 40)");
    expect(sql).toContain('ON CONFLICT DO NOTHING');
  });

  it('is classified by the migration runner probe map', () => {
    expect(runner).toContain('119_cnc_manual_svg_comment_presets*) probe_all');
    expect(runner).toContain('q_tbl cnc_manual_svg_comment_presets');
    expect(runner).toContain('119_*');
  });
});
