import { describe, expect, it } from 'vitest';
import type { ClientScreenSnapshot, ClientScreenUi } from './clientScreenSnapshotSchema';
import { clientScreenSwitchedOn } from './clientScreenPath';
import { buildMirrorView } from './mirrorView';

const snapshot: ClientScreenSnapshot = {
  title: 'Заказ № 2418',
  summary: [{ code: 'summary.client', label: 'Клиент', value: 'Садыков' }],
  tabs: [{ key: 'basic', label: 'Обзор' }, { key: 'details', label: 'Состав', counter: '3' }, { key: 'finance', label: 'Финансы' }],
  basic: [{ code: 'basic.client', label: 'Клиент', value: 'Садыков' }, { code: 'basic.order_date', label: 'Дата заказа', value: '02.10.2026' }],
  finance: {
    fields: [{ code: 'finance.final', label: 'Финальная сумма', value: '100 ₸' }],
    payments: {
      columns: [{ code: 'finance.payments', label: 'Дата', align: 'left' }, { code: 'finance.payments', label: 'Тип', align: 'left' }, { code: 'finance.payments', label: 'Сумма', align: 'right' }],
      rows: [{ id: 'payaaaaaa', cells: ['02.10.2026', 'Kaspi', '40 ₸'] }],
    },
  },
  details: {
    columns: [{ code: 'details.name', label: 'Название детали', align: 'left' }, { code: 'details.quantity', label: 'Кол-во', align: 'right' }],
    rows: [{ id: 'rowaaaaaa', cells: ['Фасад', '4'] }, { id: 'rowbbbbbb', cells: ['Цоколь', '2'] }, { id: 'rowcccccc', cells: ['Панель', '1'] }],
  },
};
const ui = (over: Partial<ClientScreenUi> = {}): ClientScreenUi => ({ tab: 'details', focus: null, editing: null, scroll: null, page: null, ...over });

describe('buildMirrorView', () => {
  it('shows the manager tab; without interface state or with an unknown tab, the first one', () => {
    expect(buildMirrorView(snapshot, ui()).activeTab).toBe('details');
    expect(buildMirrorView(snapshot, null).activeTab).toBe('basic');
    expect(buildMirrorView(snapshot, ui({ tab: 'services' })).activeTab).toBe('basic');
    expect(buildMirrorView({ ...snapshot, tabs: [] }, ui())).toMatchObject({ activeTab: null, fields: [], table: null });
    expect(buildMirrorView(snapshot, ui()).tabs.map((tab) => tab.active)).toEqual([false, true, false]);
  });

  it('marks the field the manager is on', () => {
    const view = buildMirrorView(snapshot, ui({ tab: 'basic', focus: { code: 'basic.order_date' } }));
    expect(view.fields.map((field) => field.focused)).toEqual([false, true]);
    expect(view.table).toBeNull();
  });

  it('marks the cell the manager is on and shows the values of the row being edited', () => {
    const view = buildMirrorView(snapshot, ui({
      focus: { code: 'details.quantity', rowId: 'rowbbbbbb' },
      editing: { rowId: 'rowbbbbbb', values: [{ code: 'details.quantity', value: '7' }, { code: 'details.name', value: 'Цоколь' }] },
    }));
    const row = view.table!.rows[1];
    expect(row).toMatchObject({ focused: true, editing: true });
    expect(row.cells).toEqual([{ text: 'Цоколь', focused: false, edited: false }, { text: '7', focused: true, edited: true }]);
    expect(view.table!.rows[0]).toMatchObject({ focused: false, editing: false, cells: [{ text: 'Фасад' }, { text: '4' }] });
  });

  it('an exact run of rows for the page of the manager wins over plain paging, even when it is empty', () => {
    const all = buildMirrorView(snapshot, ui({ page: null })).table!.rows.map((row) => row.id);
    expect(buildMirrorView(snapshot, ui({ page: { current: 2, size: 2, start: 1, count: 2 } })).table!.rows.map((row) => row.id)).toEqual(all.slice(1, 3));
    expect(buildMirrorView(snapshot, ui({ page: { current: 1, size: 2, start: 0, count: 0 } })).table!.rows).toEqual([]);
  });

  it('shows the manager page of the detail table; a page that no longer exists falls back to all rows', () => {
    expect(buildMirrorView(snapshot, ui({ page: { current: 2, size: 2 } })).table!.rows.map((row) => row.id)).toEqual(['rowcccccc']);
    expect(buildMirrorView(snapshot, ui({ page: { current: 9, size: 2 } })).table!.rows).toHaveLength(3);
  });

  it('orders rows by the manager groups with a title before the first row of each group', () => {
    const grouped: ClientScreenSnapshot = {
      ...snapshot,
      details: { ...snapshot.details!, groups: [{ id: 'grpaaaaaa', title: 'Белый софт', rowIds: ['rowcccccc', 'rowaaaaaa'] }, { id: 'grpbbbbbb', title: 'Графит', rowIds: ['rowbbbbbb'] }] },
    };
    const view = buildMirrorView(grouped, ui({ page: { current: 2, size: 1 } }));
    expect(view.table!.rows.map((row) => row.id)).toEqual(['rowcccccc', 'rowaaaaaa', 'rowbbbbbb']);
    expect(view.table!.groupTitleBefore).toEqual({ rowcccccc: 'Белый софт', rowbbbbbb: 'Графит' });
  });

  it('the finance tab has fields and the payments table; a focus on the payments list marks the row, not a cell', () => {
    const view = buildMirrorView(snapshot, ui({ tab: 'finance', focus: { code: 'finance.payments', rowId: 'payaaaaaa' }, editing: { rowId: 'payaaaaaa', values: [] } }));
    expect(view.fields).toHaveLength(1);
    expect(view.tableTitle).toBe('Оплаты');
    expect(view.table!.rows[0]).toMatchObject({ focused: true, editing: false });
    expect(view.table!.rows[0].cells.every((cell) => !cell.focused && !cell.edited)).toBe(true);
  });
});

describe('clientScreenSwitchedOn', () => {
  it('needs a runtime config that was actually read and the flag on', () => {
    expect(clientScreenSwitchedOn({ features: { clientScreen: true } }, true)).toBe(true);
    expect(clientScreenSwitchedOn({ features: {} }, false)).toBe(false);
    // The config request failed: a build-time "true" does not start the window.
    expect(clientScreenSwitchedOn(null, true)).toBe(false);
    expect(clientScreenSwitchedOn(undefined, true)).toBe(false);
    expect(clientScreenSwitchedOn({}, 'true')).toBe(false);
  });
});
