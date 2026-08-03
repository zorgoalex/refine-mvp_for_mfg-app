import { describe, expect, it } from 'vitest';
import {
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
});
