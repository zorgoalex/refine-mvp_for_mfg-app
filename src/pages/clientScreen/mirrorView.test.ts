import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ClientScreenSnapshot, ClientScreenUi } from './clientScreenSnapshotSchema';
import { clientScreenSwitchedOn } from './clientScreenPath';
import { buildMirrorView, clientScreenDrawnPair } from './mirrorView';

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

  it('the HDF tab shows its fields and its table', () => {
    const withHdf = {
      ...snapshot,
      tabs: [...snapshot.tabs, { key: 'hdf' as const, label: 'ХДФ' }],
      hdf: {
        fields: [{ code: 'hdf.total' as const, label: 'Итого ХДФ', value: '1,10 м², деталей: 4' }],
        table: { columns: [{ code: 'hdf.position' as const, label: 'Позиция', align: 'left' as const }], rows: [{ id: 'hdfrow0001', cells: ['1 · Фасад'] }] },
      },
    };
    const view = buildMirrorView(withHdf, ui({ tab: 'hdf' }));
    expect(view.activeTab).toBe('hdf');
    expect(view.fields.map((field) => field.value)).toEqual(['1,10 м², деталей: 4']);
    expect(view.table!.rows.map((row) => row.cells.map((cell) => cell.text))).toEqual([['1 · Фасад']]);
  });
});


describe('a snapshot is drawn together with the interface state that follows it', () => {
  const onCut: ClientScreenUi = { tab: 'cut', focus: null, editing: null, scroll: null, page: null };
  const first = { seq: 1 };
  const second = { seq: 2 };
  const third = { seq: 3 };
  const holding = { waitedOut: false, mayHold: true };

  it('the first snapshot is drawn at once; a blank is never held back', () => {
    expect(clientScreenDrawnPair(null, first, null, holding)).toEqual({ shown: first, ui: null });
    expect(clientScreenDrawnPair({ shown: first, ui: onCut }, null, null, holding)).toBeNull();
    expect(clientScreenDrawnPair({ shown: first, ui: onCut }, null, onCut, { waitedOut: true, mayHold: true })).toBeNull();
  });

  it('a new snapshot waits for its interface state: the previous pair stays, so the tab on screen does not change', () => {
    const drawn = { shown: first, ui: onCut };
    // The snapshot has come, its interface state has not: nothing changes on screen.
    expect(clientScreenDrawnPair(drawn, second, null, holding)).toBe(drawn);
    // …it has come: both are drawn.
    expect(clientScreenDrawnPair(drawn, second, onCut, holding)).toEqual({ shown: second, ui: onCut });
    // …or it never does: after the wait the snapshot is drawn without it.
    expect(clientScreenDrawnPair(drawn, second, null, { waitedOut: true, mayHold: true })).toEqual({ shown: second, ui: null });
  });

  it('the wait is one fixed stretch: snapshots that keep coming without an interface state do not prolong it', () => {
    const drawn = { shown: first, ui: onCut };
    // While the stretch runs, the newer and newer snapshots all wait…
    expect(clientScreenDrawnPair(drawn, second, null, holding)).toBe(drawn);
    expect(clientScreenDrawnPair(drawn, third, null, holding)).toBe(drawn);
    // …and when it is over, the newest one is drawn, whichever it is: what the first one showed is gone.
    expect(clientScreenDrawnPair(drawn, third, null, { waitedOut: true, mayHold: true })).toEqual({ shown: third, ui: null });
  });

  it('nothing drawn under other settings is held, not even for the wait', () => {
    const drawn = { shown: first, ui: onCut };
    expect(clientScreenDrawnPair(drawn, second, null, { waitedOut: false, mayHold: false })).toEqual({ shown: second, ui: null });
  });

  it('the interface state of the snapshot on screen is applied as it changes', () => {
    const onBasic: ClientScreenUi = { ...onCut, tab: 'basic' };
    expect(clientScreenDrawnPair({ shown: first, ui: onCut }, first, onBasic, holding)).toEqual({ shown: first, ui: onBasic });
  });

  it('the customer window holds by a timer that later snapshots do not restart, and never across a change of the settings', () => {
    const page = readFileSync(new URL('./ClientScreenPage.tsx', import.meta.url), 'utf8');
    expect(page).toContain('}, [waiting]);');
    expect(page).not.toContain('}, [waiting, received]);');
    expect(page).toContain('mayHold: held.current !== null && received !== null && held.current.shown.policyVersion === received.policyVersion,');
    expect(page).toContain('if (!waiting) waitedOut.current = false;');
  });
});
