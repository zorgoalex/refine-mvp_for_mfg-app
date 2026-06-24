import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./041_reset_bazis_label_visual_layout.sql', import.meta.url), 'utf8');

describe('041 reset Bazis label visual layout migration', () => {
  it('updates seeded and imported Bazis templates to the sample-like 85x88 layout', () => {
    expect(sql).toContain("name = 'Стандартная бирка Bazis 85x88'");
    expect(sql).toContain("name LIKE 'Импорт Bazis %'");
    expect(sql).toContain('canvas_width_mm = 85');
    expect(sql).toContain('canvas_height_mm = 88');
    expect(sql).toContain('version = version + 1');
  });

  it('uses compact sample fields instead of the cramped MVP fields', () => {
    for (const field of [
      'bazis.detail_id',
      'bazis.order_number',
      'bazis.position',
      'bazis.material',
      'bazis.detail_length',
      'bazis.detail_width',
      'date.today',
      'label.counter_text',
    ]) {
      expect(sql).toContain(field);
    }
    expect(sql).not.toContain('comment-value');
  });
});
