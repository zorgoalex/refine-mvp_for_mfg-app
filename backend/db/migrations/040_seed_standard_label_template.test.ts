import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./040_seed_standard_label_template.sql', import.meta.url), 'utf8');

describe('040 seed standard label template migration', () => {
  it('creates one idempotent standard Bazis label template with export formats', () => {
    expect(sql).toContain('Стандартная бирка Bazis 85x88');
    expect(sql).toContain('WHERE NOT EXISTS');
    expect(sql).toContain("ARRAY['bmp', 'png', 'emf']");
    expect(sql).toContain('ON CONFLICT (label_template_id, element_key) DO NOTHING');
  });

  it('binds practical Bazis fields used by generated labels', () => {
    for (const field of [
      'bazis.order_number',
      'bazis.position',
      'bazis.quantity',
      'bazis.name',
      'bazis.detail_length',
      'bazis.detail_width',
      'bazis.material',
      'bazis.comment',
    ]) {
      expect(sql).toContain(field);
    }
  });
});
