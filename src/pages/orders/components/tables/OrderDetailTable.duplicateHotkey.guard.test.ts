import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const table = readFileSync(new URL('./OrderDetailTable.tsx', import.meta.url), 'utf8');
const form = readFileSync(new URL('../OrderForm.tsx', import.meta.url), 'utf8');

describe('details grid: Ctrl+D duplicates the row', () => {
  const start = table.indexOf('const handleSpreadsheetCellKeyDown');
  const handler = table.slice(start, table.indexOf('const handleInlineEditorKeyDown', start));

  it('duplicates through the same copy action as the row menu, by key code', () => {
    expect(handler).toContain("event.code === 'KeyD'");
    expect(handler).toContain('(event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey');
    expect(handler).toContain('onCopyRow(record);');
  });

  it('acts only on a focused cell outside editing and never on a placeholder row', () => {
    const hotkey = handler.indexOf("event.code === 'KeyD'");
    expect(handler.indexOf('if ((editingKey !== null && editingField !== null) || event.defaultPrevented) return;')).toBeLessThan(hotkey);
    expect(handler.indexOf('if (event.target !== event.currentTarget) return;')).toBeLessThan(hotkey);
    expect(handler).toContain('if (!onCopyRow || record.is_placeholder === true) return;');
  });

  it('the NewLine hint names a key that exists', () => {
    expect(form).toContain('<kbd>Ctrl</kbd><kbd>D</kbd> дублировать строку');
  });
});
