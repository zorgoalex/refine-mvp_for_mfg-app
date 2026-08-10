export type OrderDetailSpreadsheetDirection =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'next'
  | 'previous';

export interface OrderDetailSpreadsheetCell {
  rowKey: string;
  columnKey: string;
}

const NON_GRID_COLUMN_KEYS = new Set(['actions']);

const DIRECT_TYPE_TEXT_FIELDS = new Set([
  'note',
  'basis_project',
  'basis_product',
  'basis_data',
  'basis_designation',
  'detail_name',
]);

const DIRECT_TYPE_NUMBER_FIELDS = new Set([
  'height',
  'width',
  'quantity',
  'milling_cost_per_sqm',
  'detail_cost',
  'priority',
]);

export function orderDetailSpreadsheetColumnKeys(
  visibleColumnKeys: readonly string[],
): string[] {
  return visibleColumnKeys.filter((key) => key.length > 0 && !NON_GRID_COLUMN_KEYS.has(key));
}

export function moveOrderDetailSpreadsheetCell(
  rowKeys: readonly string[],
  columnKeys: readonly string[],
  current: OrderDetailSpreadsheetCell,
  direction: OrderDetailSpreadsheetDirection,
): OrderDetailSpreadsheetCell | null {
  const rowIndex = rowKeys.indexOf(current.rowKey);
  const columnIndex = columnKeys.indexOf(current.columnKey);
  if (rowIndex < 0 || columnIndex < 0) return null;

  let nextRow = rowIndex;
  let nextColumn = columnIndex;
  switch (direction) {
    case 'up':
      nextRow -= 1;
      break;
    case 'down':
      nextRow += 1;
      break;
    case 'left':
      nextColumn -= 1;
      break;
    case 'right':
      nextColumn += 1;
      break;
    case 'next':
      nextColumn += 1;
      if (nextColumn >= columnKeys.length) {
        nextColumn = 0;
        nextRow += 1;
      }
      break;
    case 'previous':
      nextColumn -= 1;
      if (nextColumn < 0) {
        nextColumn = columnKeys.length - 1;
        nextRow -= 1;
      }
      break;
  }

  if (
    nextRow < 0
    || nextRow >= rowKeys.length
    || nextColumn < 0
    || nextColumn >= columnKeys.length
  ) {
    return null;
  }

  return {
    rowKey: rowKeys[nextRow],
    columnKey: columnKeys[nextColumn],
  };
}

export function orderDetailSpreadsheetTypedValue(
  field: string,
  key: string,
): string | number | null {
  if (key.length !== 1) return null;
  if (DIRECT_TYPE_TEXT_FIELDS.has(field)) return key;
  if (DIRECT_TYPE_NUMBER_FIELDS.has(field) && /^\d$/.test(key)) return Number(key);
  return null;
}

export function orderDetailSpreadsheetPastedValue(
  field: string,
  clipboardText: string,
): string | number | null {
  const firstCell = clipboardText.split(/\r?\n/, 1)[0]?.split('\t', 1)[0] ?? '';
  if (DIRECT_TYPE_TEXT_FIELDS.has(field)) return firstCell;
  if (!DIRECT_TYPE_NUMBER_FIELDS.has(field)) return null;
  const normalized = firstCell.replace(/\s/g, '').replace(',', '.');
  if (normalized.length === 0) return null;
  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}
