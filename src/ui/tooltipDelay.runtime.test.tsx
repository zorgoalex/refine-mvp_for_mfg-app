import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import AntdTable from 'antd/es/table';
import { describe, expect, it } from 'vitest';
import { ReferenceTableContext, Table } from './tooltipDelay';

describe('delayed Table runtime contract', () => {
  it('preserves every native static by identity, except the renderer', () => {
    for (const key of Object.keys(AntdTable).filter((name) => name !== '$$typeof' && name !== 'render')) {
      expect(Reflect.get(Table, key), key).toBe(Reflect.get(AntdTable, key));
    }
    expect(Table.Column).toBe(AntdTable.Column);
    expect(Table.ColumnGroup).toBe(AntdTable.ColumnGroup);
    expect(Table.Summary).toBe(AntdTable.Summary);
    expect(Table.SELECTION_ALL).toBe(AntdTable.SELECTION_ALL);
  });

  it('renders through the wrapper, not the native renderer (copying `render` would bypass the wrapper)', () => {
    expect(Reflect.get(Table, 'render')).not.toBe(Reflect.get(AntdTable, 'render'));
    const columns = [{ key: 'name', dataIndex: 'name', title: 'Категория номенклатуры' }];
    const inside = renderToStaticMarkup(<ReferenceTableContext.Provider value={true}><Table columns={columns} dataSource={[]} pagination={false} /></ReferenceTableContext.Provider>);
    expect(inside).toContain('reference-table');
    expect(inside).toContain('<span class="reference-table__title">Категория номенклатуры</span>');
    const outside = renderToStaticMarkup(<Table columns={columns} dataSource={[]} pagination={false} />);
    expect(outside).not.toContain('reference-table');
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
