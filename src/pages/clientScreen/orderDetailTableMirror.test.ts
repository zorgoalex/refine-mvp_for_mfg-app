import { describe, expect, it, vi } from 'vitest';
import {
  clearOrderDetailTableMirror, orderDetailMirrorRows, orderDetailMirrorStructure, publishOrderDetailTableMirror,
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
