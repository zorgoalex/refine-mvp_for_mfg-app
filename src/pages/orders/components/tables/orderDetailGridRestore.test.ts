import { describe, expect, it } from 'vitest';
import { canLeaveOpenRowUnchecked, readOpenedRowValues } from '../../../../utils/orderDetailRows';

const placeholder = { is_placeholder: true, detail_id: undefined };
const opened = { height: null, width: null, quantity: null, milling_type_id: 3, edge_type_id: 1, sheet_material_type_id: 12,
  film_id: 40, milling_cost_per_sqm: 9500, prefilled_milling_cost_per_sqm: 9500, note: '' };

describe('leaving an open grid row without its checks', () => {
  it('a quick-add row with the defaults (material, film, price) left as it opened — yes', () => {
    expect(canLeaveOpenRowUnchecked(placeholder, opened, { ...opened })).toBe(true);
  });

  it('a note, a size or another material — no (the row is checked and kept)', () => {
    expect(canLeaveOpenRowUnchecked(placeholder, opened, { ...opened, note: 'фасад' })).toBe(false);
    expect(canLeaveOpenRowUnchecked(placeholder, opened, { ...opened, height: 500 })).toBe(false);
    expect(canLeaveOpenRowUnchecked(placeholder, opened, { ...opened, sheet_material_type_id: 7 })).toBe(false);
  });

  it('a saved row or a row without a snapshot (opened by typing) — no', () => {
    expect(canLeaveOpenRowUnchecked({ is_placeholder: false, detail_id: undefined }, opened, { ...opened })).toBe(false);
    expect(canLeaveOpenRowUnchecked({ is_placeholder: true, detail_id: 55 }, opened, { ...opened })).toBe(false);
    expect(canLeaveOpenRowUnchecked(placeholder, null, { ...opened })).toBe(false);
  });

  it('a restored tab: the snapshot it opened with, not the current values, decides', () => {
    const checkpoint = JSON.parse(JSON.stringify({ key: 1793319737163001, values: opened }));
    const snapshot = readOpenedRowValues(checkpoint, 1793319737163001);
    expect(snapshot?.values).toEqual(opened);
    // the user had typed a note before the tab was evicted: the restored form has it, the snapshot does not
    expect(canLeaveOpenRowUnchecked(placeholder, snapshot?.values, { ...opened, note: 'фасад' })).toBe(false);
    expect(canLeaveOpenRowUnchecked(placeholder, snapshot?.values, { ...opened })).toBe(true);
    expect(readOpenedRowValues(checkpoint, 2)).toBeNull();
    expect(readOpenedRowValues({ key: 1, values: [] }, 1)).toBeNull();
  });
});
