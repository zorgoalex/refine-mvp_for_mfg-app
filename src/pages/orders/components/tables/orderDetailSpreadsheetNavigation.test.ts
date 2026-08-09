import { describe, expect, it } from 'vitest';
import {
  moveOrderDetailSpreadsheetCell,
  orderDetailSpreadsheetColumnKeys,
  orderDetailSpreadsheetColumnLabel,
  orderDetailSpreadsheetPastedValue,
  orderDetailSpreadsheetTypedValue,
} from './orderDetailSpreadsheetNavigation';

describe('order detail spreadsheet navigation', () => {
  const rows = ['101', '102', '103'];
  const columns = ['detail_number', 'height', 'width'];

  it('keeps data columns and excludes the action toolbar column', () => {
    expect(orderDetailSpreadsheetColumnKeys([
      'detail_number',
      'height',
      'area',
      'actions',
    ])).toEqual(['detail_number', 'height', 'area']);
  });

  it('moves with arrows without wrapping at grid edges', () => {
    const current = { rowKey: '102', columnKey: 'height' };

    expect(moveOrderDetailSpreadsheetCell(rows, columns, current, 'up'))
      .toEqual({ rowKey: '101', columnKey: 'height' });
    expect(moveOrderDetailSpreadsheetCell(rows, columns, current, 'down'))
      .toEqual({ rowKey: '103', columnKey: 'height' });
    expect(moveOrderDetailSpreadsheetCell(rows, columns, current, 'left'))
      .toEqual({ rowKey: '102', columnKey: 'detail_number' });
    expect(moveOrderDetailSpreadsheetCell(rows, columns, current, 'right'))
      .toEqual({ rowKey: '102', columnKey: 'width' });
    expect(moveOrderDetailSpreadsheetCell(rows, columns, {
      rowKey: '101',
      columnKey: 'detail_number',
    }, 'up')).toBeNull();
  });

  it('wraps Tab navigation into the adjacent row', () => {
    expect(moveOrderDetailSpreadsheetCell(rows, columns, {
      rowKey: '101',
      columnKey: 'width',
    }, 'next')).toEqual({ rowKey: '102', columnKey: 'detail_number' });
    expect(moveOrderDetailSpreadsheetCell(rows, columns, {
      rowKey: '102',
      columnKey: 'detail_number',
    }, 'previous')).toEqual({ rowKey: '101', columnKey: 'width' });
  });

  it('generates Excel column letters beyond Z', () => {
    expect([0, 25, 26, 27, 51, 52].map(orderDetailSpreadsheetColumnLabel))
      .toEqual(['A', 'Z', 'AA', 'AB', 'AZ', 'BA']);
  });

  it('starts direct typing only for compatible text and number cells', () => {
    expect(orderDetailSpreadsheetTypedValue('height', '7')).toBe(7);
    expect(orderDetailSpreadsheetTypedValue('note', 'П')).toBe('П');
    expect(orderDetailSpreadsheetTypedValue('film_id', '7')).toBeNull();
    expect(orderDetailSpreadsheetTypedValue('height', '.')).toBeNull();
  });

  it('accepts a single pasted Excel cell and normalizes decimal commas', () => {
    expect(orderDetailSpreadsheetPastedValue('width', '1 250,5\tignored\nnext row'))
      .toBe(1250.5);
    expect(orderDetailSpreadsheetPastedValue('note', 'Фасад\tignored'))
      .toBe('Фасад');
    expect(orderDetailSpreadsheetPastedValue('film_id', '12')).toBeNull();
    expect(orderDetailSpreadsheetPastedValue('height', 'abc')).toBeNull();
  });
});
