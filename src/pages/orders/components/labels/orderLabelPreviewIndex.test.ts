import { describe, expect, it } from 'vitest';
import {
  buildFirstLabelPageIndexByDetailId,
  firstLabelPageIndexForDetail,
  readLabelPreviewRowDetailId,
} from './orderLabelPreviewIndex';

describe('order label preview index mapping', () => {
  it('uses latest generation rows as the authority for selected detail preview', () => {
    const rows = [
      { rowIndex: 1, detailId: 101, orderId: 42, copyIndex: 1, copyCount: 2, values: {} },
      { rowIndex: 2, detailId: 101, orderId: 42, copyIndex: 2, copyCount: 2, values: {} },
      { rowIndex: 3, detailId: 202, orderId: 42, copyIndex: 1, copyCount: 1, values: {} },
    ];

    expect(firstLabelPageIndexForDetail(101, rows, [])).toBe(0);
    expect(firstLabelPageIndexForDetail(202, rows, [])).toBe(2);
    expect(firstLabelPageIndexForDetail(303, rows, [])).toBeNull();
  });

  it('falls back to quantity expansion while old latest responses do not include rows', () => {
    const details = [
      { detailId: 101, quantity: 2 },
      { detailId: 202, quantity: 0 },
      { detailId: 303, quantity: 3 },
    ];

    const indexByDetailId = buildFirstLabelPageIndexByDetailId(undefined, details);

    expect(indexByDetailId.get(101)).toBe(0);
    expect(indexByDetailId.has(202)).toBe(false);
    expect(indexByDetailId.get(303)).toBe(2);
  });

  it('accepts numeric string detail ids from JSON snapshots', () => {
    expect(readLabelPreviewRowDetailId({ detailId: '11393' })).toBe(11393);
    expect(readLabelPreviewRowDetailId({ detailId: 'not-a-number' })).toBeNull();
  });
});
