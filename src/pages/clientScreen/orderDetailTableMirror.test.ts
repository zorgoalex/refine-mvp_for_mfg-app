import { describe, expect, it, vi } from 'vitest';
import {
  clearOrderDetailTableMirror, orderDetailMirrorRows, orderDetailMirrorStructure, orderDetailPageWindow, orderDetailRowsAsSorted,
  publishOrderDetailTableMirror,
  readOrderDetailTableMirror, subscribeOrderDetailTableMirror, type OrderDetailTableMirror,
} from './orderDetailTableMirror';

const mirror = (patch: Partial<OrderDetailTableMirror> = {}): OrderDetailTableMirror => ({
  columnKeys: ['detail_number', 'height'], rowKeys: ['1', '2'], page: { current: 1, size: 50 }, grouping: null, editing: null,
  getEditingValues: () => ({}), getActiveCell: () => null, ...patch,
});
type Detail = { id: number; film: string };
const keyOf = (detail: Detail) => String(detail.id);
const labelOf = (detail: Detail) => detail.film;

describe('order detail table mirror record', () => {
  it('keeps one record per owner and tells the listeners', () => {
    const a = {};
    const b = {};
    const listener = vi.fn();
    const stop = subscribeOrderDetailTableMirror(a, listener);
    expect(readOrderDetailTableMirror(a)).toBeNull();
    publishOrderDetailTableMirror(a, mirror());
    publishOrderDetailTableMirror(b, mirror({ rowKeys: ['9'] }));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(readOrderDetailTableMirror(a)?.rowKeys).toEqual(['1', '2']);
    expect(readOrderDetailTableMirror(b)?.rowKeys).toEqual(['9']);
    clearOrderDetailTableMirror(a);
    expect(readOrderDetailTableMirror(a)).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
    clearOrderDetailTableMirror(a);
    expect(listener).toHaveBeenCalledTimes(2);
    stop();
    publishOrderDetailTableMirror(a, mirror());
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('a failing listener does not reach the table', () => {
    const owner = {};
    const second = vi.fn();
    subscribeOrderDetailTableMirror(owner, () => {
      throw new Error('customer screen failed');
    });
    subscribeOrderDetailTableMirror(owner, second);
    expect(() => publishOrderDetailTableMirror(owner, mirror())).not.toThrow();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('rows and groups as the table draws them', () => {
  it('flat table: the order on screen, no groups', () => {
    const rows: Detail[] = [{ id: 3, film: 'a' }, { id: 1, film: 'b' }];
    expect(orderDetailMirrorRows(rows, { groupField: null, keyOf, labelOf })).toEqual({ rowKeys: ['3', '1'], grouping: null });
  });

  it('grouped table: groups top to bottom, the first one titled even without a separator line', () => {
    const rows = [
      { kind: 'detail' as const, detail: { id: 1, film: 'Белая' }, groupIndex: 0 },
      { kind: 'detail' as const, detail: { id: 4, film: 'Белая' }, groupIndex: 0 },
      { kind: 'summary' as const },
      { kind: 'separator' as const, groupIndex: 1, key: '__sep__:film:7:1', label: 'Дуб' },
      { kind: 'detail' as const, detail: { id: 2, film: 'Дуб' }, groupIndex: 1 },
      { id: 99, film: '' },
    ];
    expect(orderDetailMirrorRows<Detail>(rows, { groupField: 'film', keyOf, labelOf })).toEqual({
      rowKeys: ['1', '4', '2', '99'],
      grouping: { field: 'film', groups: [{ key: '0', label: 'Белая', rowKeys: ['1', '4'] }, { key: '1', label: 'Дуб', rowKeys: ['2'] }] },
    });
  });

  it('a leading separator gives the first group its own label', () => {
    const rows = [
      { kind: 'separator' as const, groupIndex: 0, key: 's0', label: 'Раскрой 12' },
      { kind: 'detail' as const, detail: { id: 1, film: 'x' }, groupIndex: 0 },
    ];
    expect(orderDetailMirrorRows<Detail>(rows, { groupField: 'cut_job', keyOf, labelOf }).grouping?.groups).toEqual([{ key: '0', label: 'Раскрой 12', rowKeys: ['1'] }]);
  });

  it('rows without a key are skipped', () => {
    expect(orderDetailMirrorRows<Detail>([{ id: 0, film: '' }], { groupField: null, keyOf: () => null, labelOf }).rowKeys).toEqual([]);
  });
});

describe('what needs a new snapshot', () => {
  it('columns, row order, groups and the edited row do; the page and the cell do not', () => {
    const base = orderDetailMirrorStructure(mirror());
    expect(orderDetailMirrorStructure(mirror({ page: { current: 2, size: 50 } }))).toBe(base);
    expect(orderDetailMirrorStructure(mirror({ editing: null }))).toBe(base);
    expect(orderDetailMirrorStructure(mirror({ columnKeys: ['height'] }))).not.toBe(base);
    expect(orderDetailMirrorStructure(mirror({ rowKeys: ['2', '1'] }))).not.toBe(base);
    expect(orderDetailMirrorStructure(mirror({ editing: { rowKey: '1', field: 'height' } }))).not.toBe(base);
    expect(orderDetailMirrorStructure(mirror({ editing: { rowKey: '1', field: 'width' } })))
      .toBe(orderDetailMirrorStructure(mirror({ editing: { rowKey: '1', field: 'height' } })));
    expect(orderDetailMirrorStructure(null)).toBe('');
  });
});

describe('rows as the table component sorts them', () => {
  type Row = { id: string; n: number | undefined };
  // 15 filled rows and 5 empty grid rows at the end, as the table hands them to the component.
  const rows: Row[] = [
    ...Array.from({ length: 15 }, (_, index) => ({ id: `d${index + 1}`, n: index + 1 })),
    ...Array.from({ length: 5 }, (_, index) => ({ id: `p${index + 1}`, n: undefined })),
  ];
  const byNumber = (left: Row, right: Row) => (left.n as number) - (right.n as number);
  const byNumberOrZero = (left: Row, right: Row) => (left.n || 0) - (right.n || 0);

  it('no active sort: the order is kept', () => {
    expect(orderDetailRowsAsSorted(rows, undefined, 'ascend')).toEqual(rows);
    expect(orderDetailRowsAsSorted(rows, byNumberOrZero, null)).toEqual(rows);
  });

  it('descending: filled rows turn round; empty rows go where the comparator puts them', () => {
    const sorted = orderDetailRowsAsSorted(rows, byNumberOrZero, 'descend').map((row) => row.id);
    expect(sorted.slice(0, 3)).toEqual(['d15', 'd14', 'd13']);
    expect(sorted.slice(15)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5']);
    const ascending = orderDetailRowsAsSorted(rows, byNumberOrZero, 'ascend').map((row) => row.id);
    expect(ascending.slice(0, 6)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'd1']);
  });

  it('a comparator that cannot compare empty rows (NaN) leaves them where they are; the sort is stable', () => {
    const sorted = orderDetailRowsAsSorted(rows, byNumber, 'descend').map((row) => row.id);
    expect(sorted).toHaveLength(20);
    expect(new Set(sorted).size).toBe(20);
    const equal = orderDetailRowsAsSorted([{ id: 'a', n: 1 }, { id: 'b', n: 1 }, { id: 'c', n: 1 }], byNumber, 'descend').map((row) => row.id);
    expect(equal).toEqual(['a', 'b', 'c']);
  });
});

describe('the page of the manager among the rows of the customer', () => {
  const filled = Array.from({ length: 15 }, (_, index) => `d${index + 1}`);
  const empty = ['p1', 'p2', 'p3', 'p4', 'p5'];
  const shown = new Set(filled);

  it('empty rows last: pages are plain runs', () => {
    const rowKeys = [...filled, ...empty];
    expect(orderDetailPageWindow(rowKeys, { current: 1, size: 10 }, shown)).toEqual({ start: 0, count: 10 });
    expect(orderDetailPageWindow(rowKeys, { current: 2, size: 10 }, shown)).toEqual({ start: 10, count: 5 });
  });

  it('empty rows first (ascending sort): page 1 holds five empty rows and five details', () => {
    const rowKeys = [...empty, ...filled];
    expect(orderDetailPageWindow(rowKeys, { current: 1, size: 10 }, shown)).toEqual({ start: 0, count: 5 });
    expect(orderDetailPageWindow(rowKeys, { current: 2, size: 10 }, shown)).toEqual({ start: 5, count: 10 });
  });

  it('a page of empty rows only, and a page past the end: nothing of the customer is on it', () => {
    expect(orderDetailPageWindow([...filled.slice(0, 10), ...empty, ...empty], { current: 2, size: 10 }, new Set(filled.slice(0, 10)))).toEqual({ start: 10, count: 0 });
    expect(orderDetailPageWindow([...filled, ...empty], { current: 9, size: 10 }, shown)).toEqual({ start: 15, count: 0 });
  });

  it('the empty row being filled is a row of the customer as well', () => {
    const rowKeys = [...filled, ...empty];
    expect(orderDetailPageWindow(rowKeys, { current: 2, size: 10 }, new Set([...filled, 'p1']))).toEqual({ start: 10, count: 6 });
  });
});
