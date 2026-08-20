import { describe, expect, it } from 'vitest';
import type { OrderDetail } from '../../../../types/orders';
import {
  calculateOrderDetailTableBodyScrollY,
  isOrderDetailSelectVerticalNavigationKey,
  isLastOrderDetailRow,
  pageContainingOrderDetail,
  sortOrderDetailsForPagination,
} from './OrderDetailTable';

const details = Array.from({ length: 51 }, (_, index) => ({
  temp_id: index + 1,
  detail_number: index + 1,
  height: (index + 1) * 10,
})) as OrderDetail[];

describe('order detail controlled pagination', () => {
  it('opens a quick-added 51st detail on page two at page size 50', () => {
    const ordered = sortOrderDetailsForPagination(
      details,
      (left, right) => left.detail_number - right.detail_number,
      'ascend',
    );
    expect(pageContainingOrderDetail(ordered, details[50], 50)).toBe(2);
  });

  it('uses the active table sort order when calculating the target page', () => {
    const ordered = sortOrderDetailsForPagination(
      details,
      (left, right) => Number(left.height) - Number(right.height),
      'descend',
    );
    expect(pageContainingOrderDetail(ordered, details[50], 50)).toBe(1);
    expect(pageContainingOrderDetail(ordered, details[0], 50)).toBe(2);
  });

  it('recalculates the edited row page after the page size changes', () => {
    expect(pageContainingOrderDetail(details, details[50], 50)).toBe(2);
    expect(pageContainingOrderDetail(details, details[50], 100)).toBe(1);
  });

  it('keeps duplicate sorter values deterministic by row key', () => {
    const tied = [
      { temp_id: 3, detail_number: 1 },
      { temp_id: 1, detail_number: 2 },
      { temp_id: 2, detail_number: 3 },
    ] as OrderDetail[];
    expect(sortOrderDetailsForPagination(tied, () => 0, 'ascend').map((row) => row.temp_id))
      .toEqual([1, 2, 3]);
  });

  it('detects the last visible detail row by temp or persisted row key', () => {
    expect(isLastOrderDetailRow(details, details[50])).toBe(true);
    expect(isLastOrderDetailRow(details, details[49])).toBe(false);

    const persisted = [
      { detail_id: 10, detail_number: 1 },
      { detail_id: 11, detail_number: 2 },
    ] as OrderDetail[];
    expect(isLastOrderDetailRow(persisted, { detail_id: 11 } as OrderDetail)).toBe(true);
  });

  it('adds spare body height so the last filled detail row is not clipped', () => {
    expect(calculateOrderDetailTableBodyScrollY(0, 0)).toBe(39);
    expect(calculateOrderDetailTableBodyScrollY(0, 1)).toBe(78);
    expect(calculateOrderDetailTableBodyScrollY(5, 5)).toBe(234);
    expect(calculateOrderDetailTableBodyScrollY(0, 20)).toBe(819);
    expect(calculateOrderDetailTableBodyScrollY(0, 21)).toBe(560);
    expect(calculateOrderDetailTableBodyScrollY(100, 100)).toBe(560);
  });

  it('leaves both vertical arrows to an open detail Select', () => {
    expect(isOrderDetailSelectVerticalNavigationKey('ArrowDown')).toBe(true);
    expect(isOrderDetailSelectVerticalNavigationKey('ArrowUp')).toBe(true);
    expect(isOrderDetailSelectVerticalNavigationKey('ArrowLeft')).toBe(false);
  });
});
