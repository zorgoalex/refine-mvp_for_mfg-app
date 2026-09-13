import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { ColumnsType } from 'antd/es/table';
import { getTableColumnDataIndex, getTableStickyOffsetHeader } from './tableCompatibility';

describe('table column union compatibility', () => {
  const columns: ColumnsType<{ height: number }> = [
    { key: 'preferred', dataIndex: 'height' },
    { dataIndex: 'height' },
    { dataIndex: ['dimensions', 'height'] },
    { key: 0, dataIndex: 'height' },
    { title: 'Group', children: [{ dataIndex: 'height' }] },
    { title: 'Action' },
  ];

  it('preserves leaf indexes, including the original array reference', () => {
    expect(getTableColumnDataIndex(columns[0])).toBe('height');
    const index = getTableColumnDataIndex(columns[2]);
    expect(index).toEqual(['dimensions', 'height']);
    expect(getTableColumnDataIndex(columns[2])).toBe(index);
  });

  it('returns undefined for groups and action columns without indexes', () => {
    expect(getTableColumnDataIndex(columns[4])).toBeUndefined();
    expect(getTableColumnDataIndex(columns[5])).toBeUndefined();
  });

  it('preserves key precedence and existing spreadsheet fallback strings', () => {
    expect(columns.map(column => String(column.key ?? getTableColumnDataIndex(column) ?? '')))
      .toEqual(['preferred', 'height', 'dimensions,height', '0', '', '']);
  });
});

describe('table sticky offset compatibility', () => {
  it.each([undefined, false, true, {}])('preserves absent offset for %j', sticky => {
    expect(getTableStickyOffsetHeader(sticky)).toBeUndefined();
  });

  it.each([0, 24, -1])('preserves offset %s', offsetHeader => {
    expect(getTableStickyOffsetHeader({ offsetHeader })).toBe(offsetHeader);
  });

  it('invalidates the offset comparison when the sticky header position changes', () => {
    expect(getTableStickyOffsetHeader({ offsetHeader: 24 }) === getTableStickyOffsetHeader({ offsetHeader: 48 })).toBe(false);
    expect(getTableStickyOffsetHeader(false) === getTableStickyOffsetHeader({ offsetHeader: 0 })).toBe(false);
    expect(getTableStickyOffsetHeader(true) === getTableStickyOffsetHeader({})).toBe(true);
  });
});

it('wires the checked accessors into both real order tables', () => {
  const edit = readFileSync(new URL('../components/tables/OrderDetailTable.tsx', import.meta.url), 'utf8');
  const show = readFileSync(new URL('../show.tsx', import.meta.url), 'utf8');
  expect(edit.match(/getTableColumnDataIndex\(column\)/g)).toHaveLength(2);
  expect(show).toContain('getTableColumnDataIndex(column)');
  expect(show).toContain('getTableStickyOffsetHeader(previous.sticky) === getTableStickyOffsetHeader(current.sticky)');
});
