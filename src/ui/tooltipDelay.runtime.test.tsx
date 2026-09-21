import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import AntdTable from 'antd/es/table';
import { describe, expect, it } from 'vitest';
import { Table } from './tooltipDelay';

describe('delayed Table runtime contract', () => {
  it('preserves every native enumerable static by identity', () => {
    for (const key of Object.keys(AntdTable)) {
      expect(Reflect.get(Table, key), key).toBe(Reflect.get(AntdTable, key));
    }
    expect(Table.Column).toBe(AntdTable.Column);
    expect(Table.ColumnGroup).toBe(AntdTable.ColumnGroup);
    expect(Table.Summary).toBe(AntdTable.Summary);
    expect(Table.SELECTION_ALL).toBe(AntdTable.SELECTION_ALL);
  });

  it('preserves the existing native forwardRef renderer', () => {
    // Object.assign already copies render. Fixing the resulting delay bypass
    // is a separate runtime change, not part of this type-only contract fix.
    expect(Reflect.get(Table, '$$typeof')).toBe(Reflect.get(AntdTable, '$$typeof'));
    expect(Reflect.get(Table, 'render')).toBe(Reflect.get(AntdTable, 'render'));
  });

  it('renders the same native table markup', () => {
    const props = {
      dataSource: [{ key: 'test', name: 'Тест' }],
      columns: [{ key: 'name', dataIndex: 'name', title: 'Имя' }],
      pagination: false as const,
      showSorterTooltip: false as const,
    };
    expect(renderToStaticMarkup(<Table {...props} />))
      .toBe(renderToStaticMarkup(<AntdTable {...props} />));
  });
});
