// «NewLine», mockup 03: the orders table with group header rows. A header row spans the whole table;
// the order rows keep their columns, renders and selection.
import React from 'react';
import type { ColumnsType } from 'antd/es/table';
import type { OrderListGroup } from './orderListWorkbench';

export const ORDER_GROUP_ROW = '__orderGroup';

export type GroupHeaderRow = { [ORDER_GROUP_ROW]: true; order_id: string; label: string; count: number };

export function isOrderGroupRow(row: unknown): row is GroupHeaderRow {
  return Boolean(row && typeof row === 'object' && (row as Record<string, unknown>)[ORDER_GROUP_ROW] === true);
}

/** A header row before each group's orders. One group without a label (no grouping) — just the rows. */
export function flattenOrderGroups<T>(groups: OrderListGroup<T>[]): Array<T | GroupHeaderRow> {
  if (groups.length === 1 && groups[0].label === '') return groups[0].rows;
  return groups.flatMap((group) => [
    { [ORDER_GROUP_ROW]: true as const, order_id: `group:${group.key}`, label: group.label, count: group.rows.length },
    ...group.rows,
  ]);
}

/** The same columns; on a header row the first one spans the table and the others are hidden. */
export function withGroupHeaderColumns<T>(columns: ColumnsType<T>): ColumnsType<T | GroupHeaderRow> {
  const span = columns.length + 1; // + the selection column, when there is one (an extra span is harmless)
  return columns.map((column, index) => {
    const original = column as ColumnsType<T>[number] & {
      render?: (value: unknown, record: T, rowIndex: number) => React.ReactNode;
      onCell?: (record: T, rowIndex?: number) => React.HTMLAttributes<HTMLElement> & { colSpan?: number };
    };
    return {
      ...original,
      render: (value: unknown, record: T | GroupHeaderRow, rowIndex: number) => {
        if (isOrderGroupRow(record)) {
          return index === 0 ? (
            <span className="wb-order-group__title">
              {record.label}
              <span className="wb-order-group__count">{record.count}</span>
            </span>
          ) : null;
        }
        return original.render ? original.render(value, record, rowIndex) : (value as React.ReactNode);
      },
      onCell: (record: T | GroupHeaderRow, rowIndex?: number) => {
        if (isOrderGroupRow(record)) return { colSpan: index === 0 ? span : 0 };
        return original.onCell ? original.onCell(record, rowIndex) : {};
      },
    } as ColumnsType<T | GroupHeaderRow>[number];
  });
}
