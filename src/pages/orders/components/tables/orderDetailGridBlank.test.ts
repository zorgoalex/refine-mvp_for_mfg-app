import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isOpenRowUntouched } from '../../../../utils/orderDetailRows';

const opened = { height: null, width: null, quantity: null, milling_type_id: 9, film_id: null, note: '', milling_cost_per_sqm: 9500 };

describe('leaving an untouched empty grid row', () => {
  it('nothing changed since it opened (empty values equal each other)', () => {
    expect(isOpenRowUntouched(opened, { ...opened, note: undefined, film_id: undefined })).toBe(true);
  });

  it('anything typed or chosen — a size, a note, a material, another milling — keeps the row checks', () => {
    expect(isOpenRowUntouched(opened, { ...opened, height: 500 })).toBe(false);
    expect(isOpenRowUntouched(opened, { ...opened, note: 'фасад' })).toBe(false);
    expect(isOpenRowUntouched(opened, { ...opened, sheet_material_type_id: 7 })).toBe(false);
    expect(isOpenRowUntouched(opened, { ...opened, milling_type_id: 3 })).toBe(false);
    expect(isOpenRowUntouched(opened, { ...opened, milling_cost_per_sqm: '9500' })).toBe(true);
  });
});

describe('the details grid wiring', () => {
  const table = readFileSync(join(__dirname, 'OrderDetailTable.tsx'), 'utf8');

  it('moving to another row goes through leaveCurrentRow (order save keeps its own empty-tail rule)', () => {
    expect(table).toContain('const leaveCurrentRow = async (): Promise<boolean> => {');
    expect(table.match(/leaveCurrentRow\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(7);
    expect(table).toContain('return await saveCurrentRow({ allowEmptyTailRow: true });');
  });

  it('quick add and Tab past the last field leave the row the same way (a note-only row is kept and checked)', () => {
    const tab = readFileSync(join(__dirname, '../tabs/OrderDetailsTab.tsx'), 'utf8');
    expect(tab).toContain('const saved = await tableRef.current.leaveCurrentEdits();');
    expect(table).toContain('saveCurrentRow: leaveCurrentRow,');
    expect(table).toContain('return await leaveCurrentRow();');
  });

  it('a restored tab keeps the snapshot of the untouched open row', () => {
    expect(table).toContain('openedRowValuesRef.current = readOpenedRowValues(restored?.openedRowValues, editingKey);');
  });

  it('an untouched prepared row shows only its number and actions until it is opened', () => {
    expect(table).toContain("const BLANK_PLACEHOLDER_KEPT_COLUMNS = new Set(['detail_number', 'actions']);");
    expect(table).toContain('if (d && isOrderDetailPlaceholder(d) && !isEditing(d)) return null;');
    expect(table).toContain('if (isPlaceholderKey(editingKey)) cellRuntime.notifyRow(editingKey);');
  });
});
