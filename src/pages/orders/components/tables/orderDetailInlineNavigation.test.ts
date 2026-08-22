import { describe, expect, it, vi } from 'vitest';
import {
  findOrderDetailInlineEditor,
  finishOrderDetailInlineTab,
  focusOrderDetailInlineEditorAtEnd,
  mergeOrderDetailLiveNumericValues,
  nextOrderDetailInlineTabField,
  orderDetailInlineTabFields,
} from './orderDetailInlineNavigation';

describe('order detail inline Tab navigation', () => {
  it('follows visible column order and skips non-entry columns', () => {
    expect(orderDetailInlineTabFields(
      ['detail_number', 'width', 'area', 'height', 'cut_job', 'film_id', 'actions'],
      { detailCostEditable: false },
    )).toEqual(['width', 'height', 'film_id']);
  });

  it('skips locked calculated cost and includes it after manual unlock', () => {
    const visibleKeys = ['milling_cost_per_sqm', 'detail_cost', 'film_id'];

    expect(orderDetailInlineTabFields(visibleKeys, { detailCostEditable: false }))
      .toEqual(['milling_cost_per_sqm', 'film_id']);
    expect(orderDetailInlineTabFields(visibleKeys, { detailCostEditable: true }))
      .toEqual(visibleKeys);
  });

  it('moves both forward and backward without wrapping', () => {
    const fields = ['height', 'width', 'quantity'];

    expect(nextOrderDetailInlineTabField(fields, 'width', false)).toBe('quantity');
    expect(nextOrderDetailInlineTabField(fields, 'width', true)).toBe('height');
    expect(nextOrderDetailInlineTabField(fields, 'quantity', false)).toBeNull();
    expect(nextOrderDetailInlineTabField(fields, 'height', true)).toBeNull();
  });

  it('finds the editor inside the active cell instead of the row selection checkbox', () => {
    const selectionCheckbox = { focus: vi.fn() };
    const activeEditor = { focus: vi.fn() };
    const editingCellQuery = vi.fn().mockReturnValue(activeEditor);
    const rowQuery = vi.fn((selector: string) =>
      selector === 'input, textarea, [role="combobox"]'
        ? selectionCheckbox
        : { querySelector: editingCellQuery },
    );

    const editor = findOrderDetailInlineEditor(
      { querySelector: rowQuery } as unknown as ParentNode,
      'width',
    );

    expect(rowQuery).toHaveBeenCalledTimes(1);
    expect(rowQuery).toHaveBeenCalledWith('[data-order-detail-column-key="width"]');
    expect(editingCellQuery).toHaveBeenCalledWith('input, textarea, [role="combobox"]');
    expect(editor).toBe(activeEditor);
    expect(editor).not.toBe(selectionCheckbox);
  });

  it('focuses a double-click editor with the caret after its current value', () => {
    const editor = {
      value: 'Существующее значение',
      focus: vi.fn(),
      setSelectionRange: vi.fn(),
    };

    focusOrderDetailInlineEditorAtEnd(editor as unknown as HTMLElement);

    expect(editor.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(editor.setSelectionRange).toHaveBeenCalledWith(21, 21);
  });

  it('focuses a checkbox without trying to set a text selection', () => {
    const editor = {
      type: 'checkbox',
      value: 'on',
      focus: vi.fn(),
      setSelectionRange: vi.fn(),
    };

    focusOrderDetailInlineEditorAtEnd(editor as unknown as HTMLElement);

    expect(editor.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(editor.setSelectionRange).not.toHaveBeenCalled();
  });

  it('uses the latest numeric editor values before ArrowDown validation', () => {
    expect(mergeOrderDetailLiveNumericValues(
      { height: 0, width: 0, quantity: 1, note: 'A' },
      { height: 1000, width: 200, quantity: 1 },
    )).toEqual({ height: 1000, width: 200, quantity: 1, note: 'A' });
  });

  it('keeps the latest manual price and sum while merging live values', () => {
    expect(mergeOrderDetailLiveNumericValues(
      { milling_cost_per_sqm: 100, detail_cost: 20 },
      { milling_cost_per_sqm: 125, detail_cost: 25 },
    )).toEqual({ milling_cost_per_sqm: 125, detail_cost: 25 });
  });

  it('saves and adds a new row after Tab on the final field', async () => {
    const saveCurrentRow = vi.fn().mockResolvedValue(true);
    const onQuickAdd = vi.fn();
    const fields = ['height', 'width', 'film_id'];

    expect(nextOrderDetailInlineTabField(fields, 'film_id', false)).toBeNull();
    await finishOrderDetailInlineTab({ saveCurrentRow, isLastRow: true, onQuickAdd });

    expect(saveCurrentRow).toHaveBeenCalledTimes(1);
    expect(onQuickAdd).toHaveBeenCalledTimes(1);
  });

  it('does not add a row when save fails or the edited row is not last', async () => {
    const onQuickAdd = vi.fn();

    await finishOrderDetailInlineTab({
      saveCurrentRow: vi.fn().mockResolvedValue(false),
      isLastRow: true,
      onQuickAdd,
    });
    await finishOrderDetailInlineTab({
      saveCurrentRow: vi.fn().mockResolvedValue(true),
      isLastRow: false,
      onQuickAdd,
    });

    expect(onQuickAdd).not.toHaveBeenCalled();
  });

  it('returns false when quick add rejects the new row after a successful save', async () => {
    const result = await finishOrderDetailInlineTab({
      saveCurrentRow: vi.fn().mockResolvedValue(true),
      isLastRow: true,
      onQuickAdd: vi.fn().mockResolvedValue(false),
    });

    expect(result).toBe(false);
  });
});
