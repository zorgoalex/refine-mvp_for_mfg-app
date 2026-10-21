import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// No DOM in unit tests: the editor's lock while saving is checked on the source.
const source = readFileSync(new URL('./ContactsCard.tsx', import.meta.url), 'utf8');

describe('ContactsCard locks the set while a save is in flight', () => {
  it('every editing control is disabled while saving and changes are ignored', () => {
    const editor = source.slice(source.indexOf('{rows.map((row) =>'), source.indexOf('<Typography.Text type="secondary" style={{ fontSize: 12 }}>'));
    for (const control of ['<Select', '<Input', '<Checkbox', 'aria-label="Удалить контакт"', 'icon={<PlusOutlined />}']) {
      const blocks = editor.split(control).slice(1).map((rest) => rest.slice(0, rest.indexOf('>')));
      expect(blocks.length, control).toBeGreaterThan(0);
      for (const block of blocks) expect(block, control).toMatch(/disabled=\{busy/);
    }
    expect(source).toMatch(/const busy = saving \|\| reloading \|\| locked;/);
    expect(source).toMatch(/const change = \(next: EmployeeContactDraft\[\]\) => \{ if \(busy\) return;/);
  });

  it('a load ends «reloading» in finally (only the latest one), so the editor unlocks after every load', () => {
    const load = source.slice(source.indexOf('const load = useCallback('), source.indexOf('}, [ownerId, source, reloadToken]);'));
    expect(load).toContain('const generation = ++loadGeneration.current;');
    expect(load).toContain('setReloading(true);');
    expect(load).toMatch(/\} finally \{\s*if \(generation === loadGeneration\.current\) setReloading\(false\);\s*\}/);
    // Every setReloading(true) has its finally: no early return before the try.
    expect(load.indexOf('setReloading(true);')).toBeLessThan(load.indexOf('try {'));
    expect(load.slice(load.indexOf('setReloading(true);'), load.indexOf('try {'))).not.toContain('return');
  });
});
