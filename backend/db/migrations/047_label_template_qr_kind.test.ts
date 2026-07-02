import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./047_label_template_qr_kind.sql', import.meta.url), 'utf8');
const liveSql = sql
  .split(/--\s*Rollback:/i)[0]
  ?.trim() ?? '';

describe('047 label template qr kind migration', () => {
  it('drops and re-adds the element kind constraint with qr included', () => {
    expect(liveSql).toMatch(/ALTER TABLE label_template_elements\s+DROP CONSTRAINT IF EXISTS chk_label_template_elements_kind;/i);
    expect(liveSql).toMatch(/ALTER TABLE label_template_elements\s+ADD CONSTRAINT chk_label_template_elements_kind\s+CHECK \(kind IN \('text', 'line', 'rect', 'qr'\)\);/i);
  });

  it('documents rollback back to text, line, and rect only after removing qr rows', () => {
    expect(sql).toMatch(/--\s*DELETE FROM label_template_elements WHERE kind = 'qr';/i);
    expect(sql).toMatch(/--\s*ALTER TABLE label_template_elements DROP CONSTRAINT IF EXISTS chk_label_template_elements_kind;/i);
    expect(sql).toMatch(/--\s*ALTER TABLE label_template_elements\s+--\s*ADD CONSTRAINT chk_label_template_elements_kind\s+--\s*CHECK \(kind IN \('text', 'line', 'rect'\)\);/i);
  });
});
