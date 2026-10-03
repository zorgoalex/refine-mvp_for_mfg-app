import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// No DOM in unit tests: the editor's lock while saving is checked on the source.
const source = readFileSync(new URL('./EmployeeContactsCard.tsx', import.meta.url), 'utf8');

describe('EmployeeContactsCard locks the set while a save is in flight', () => {
  it('every editing control is disabled while saving and changes are ignored', () => {
    const editor = source.slice(source.indexOf('{rows.map((row) => ('), source.indexOf('<Typography.Text type="secondary" style={{ fontSize: 12 }}>'));
    for (const control of ['<Select', '<Input', '<Checkbox', 'aria-label="Удалить контакт"', 'icon={<PlusOutlined />}']) {
      const blocks = editor.split(control).slice(1).map((rest) => rest.slice(0, rest.indexOf('>')));
      expect(blocks.length, control).toBeGreaterThan(0);
      for (const block of blocks) expect(block, control).toMatch(/disabled=\{saving/);
    }
    expect(source).toMatch(/const change = \(next: EmployeeContactDraft\[\]\) => \{ if \(saving\) return;/);
  });
});
