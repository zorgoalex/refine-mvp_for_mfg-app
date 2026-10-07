import { clientScreenOrderPath, clientScreenUnmountAction, orderShowPresentationKey } from './clientScreenOrderKeys';
import { describe, expect, it } from 'vitest';
import { CLIENT_SCREEN_PATH } from './clientScreenPath';
import { clientScreenWindowFeatures, pickCustomerScreen } from './openClientScreenWindow';
import { clientScreenControlModel } from './clientScreenControlModel';
import type { ClientScreenPresenterView } from './clientScreenPresenter';
import { mirroredEditing, mirroredPage, mirroredTab, orderFormMirrorTabs, orderFormNames } from './useClientScreenOrderBridge';

describe('opening the customer window', () => {
  it('always opens with noopener, so the drafts in sessionStorage are never copied into it', () => {
    expect(clientScreenWindowFeatures(null)).toBe('popup,noopener,width=1280,height=800');
    expect(clientScreenWindowFeatures({ availLeft: 1920.4, availTop: 0, availWidth: 2560, availHeight: 1400.6 })).toBe('popup,noopener,left=1920,top=0,width=2560,height=1401');
    expect(clientScreenWindowFeatures({ left: -1280, top: 40, availWidth: 1280, availHeight: 984 })).toBe('popup,noopener,left=-1280,top=40,width=1280,height=984');
    expect(CLIENT_SCREEN_PATH).toBe('/client-screen.html');
  });

  it('picks a screen other than the one the manager window is on; with one screen there is none', () => {
    const first = { availWidth: 1920, availHeight: 1040 };
    const second = { availWidth: 2560, availHeight: 1400 };
    expect(pickCustomerScreen([first, second], first)).toBe(second);
    expect(pickCustomerScreen([first, second], second)).toBe(first);
    expect(pickCustomerScreen([first], first)).toBeNull();
    expect(pickCustomerScreen([], undefined)).toBeNull();
  });
});

describe('order form bridge helpers', () => {
  it('mirrors the tabs with the labels and order of the layout the manager uses', () => {
    expect(orderFormMirrorTabs(false)).toEqual([
      { key: 'basic', label: 'Основная информация' }, { key: 'details', label: 'Детали заказа' }, { key: 'hdf', label: 'ХДФ' }, { key: 'dates', label: 'Даты' },
      { key: 'finance', label: 'Финансы' }, { key: 'services', label: 'Услуги/товары' },
    ]);
    expect(orderFormMirrorTabs(true).map((tab) => `${tab.key}:${tab.label}`)).toEqual(['basic:Обзор', 'details:Состав', 'hdf:ХДФ', 'finance:Финансы', 'dates:Логистика', 'services:Услуги/товары']);
  });

  it('resolves names from the references the form has loaded; unknown ids and missing references give no name', () => {
    const references = {
      clients: [{ value: 5, label: 'Садыков Арман' }], orderStatuses: [{ value: 2, label: 'В работе' }], paymentStatuses: [], employees: [{ value: 9, label: 'Алия К.' }],
      productionStatusNameById: new Map([[4, 'Фрезеровка']]), millingTypeNameById: new Map([[1, 'Модерн']]), edgeTypeNameById: new Map(),
      filmNameById: new Map([[8, 'Белый софт']]), paymentTypeNameById: new Map([[2, 'Kaspi']]),
    } as never;
    const names = orderFormNames(references, (id) => (id === 3 ? 'МДФ 16 мм' : undefined));
    expect([names.client(5), names.orderStatus(2), names.employee(9), names.productionStatus(4), names.millingType(1), names.film(8), names.paymentType(2), names.sheetMaterial(3)])
      .toEqual(['Садыков Арман', 'В работе', 'Алия К.', 'Фрезеровка', 'Модерн', 'Белый софт', 'Kaspi', 'МДФ 16 мм']);
    expect([names.client(6), names.paymentStatus(1), names.edgeType(2), names.client(null), names.film(undefined)]).toEqual([undefined, undefined, undefined, undefined, undefined]);
    const empty = orderFormNames(null, () => undefined);
    expect([empty.client(5), empty.film(8)]).toEqual([undefined, undefined]);
  });
});

describe('customer screen control in the order header', () => {
  const view = (over: Partial<ClientScreenPresenterView> = {}): ClientScreenPresenterView =>
    ({ phase: 'idle', presentedOrderKey: null, lost: null, workstationDisabled: false, policyStale: false, presentingElsewhere: false, ...over });

  it('the order header offers presenting; the emergency switch-off is not its business any more', () => {
    // Tab B: nothing presented here; another browser tab may be presenting.
    expect(clientScreenControlModel(view(), '7', true)).toMatchObject({ mode: 'idle', label: 'Показать клиенту', canPresent: true });
    expect(clientScreenControlModel(view({ presentedOrderKey: '9', phase: 'owner' }), '7', true)).toMatchObject({ mode: 'idle', label: 'Показать этот заказ' });
    expect(clientScreenControlModel(view({ presentedOrderKey: '7', phase: 'owner' }), '7', true)).toEqual({ mode: 'presenting', waiting: false });
    expect(clientScreenControlModel(view({ presentedOrderKey: '7', phase: 'claiming' }), '7', true)).toMatchObject({ mode: 'presenting', waiting: true });
    expect(clientScreenControlModel(view({ presentedOrderKey: '7', phase: 'owner', policyStale: true }), '7', true)).toMatchObject({ waiting: true });
    expect(clientScreenControlModel(view({ workstationDisabled: true, presentedOrderKey: '7' }), '7', true)).toEqual({ mode: 'workstation-off' });
  });

  it('does not offer to present while the form has no backend reference names (the customer would see dashes)', () => {
    const model = clientScreenControlModel(view(), '7', false);
    expect(model).toMatchObject({ mode: 'idle', canPresent: false });
    expect(model.mode === 'idle' && model.hint).toContain('справочники');
  });

  it('maps the manager tab to a mirrored tab or to nothing', () => {
    expect(['basic', 'details', 'hdf', 'dates', 'finance', 'services'].map(mirroredTab)).toEqual(['basic', 'details', 'hdf', 'dates', 'finance', 'services']);
    expect(['cut', 'workshops', 'requirements', 'additional', ''].map(mirroredTab)).toEqual([null, null, null, null, null]);
  });
});

describe('what the detail table shows, for the customer screen', () => {
  const names = orderFormNames(null, () => undefined, new Map([[8, 'Белый софт (снята)']]));
  const details = [{ detail_id: 71, detail_number: 1, height: 716, width: 396, quantity: 4, area: 1.13, film_id: 8 }] as never[];
  const idFor = (scope: string, key: string) => `${scope}${key}`.replace(/[^a-z0-9]/g, '');
  const table = (editing: { rowKey: string; field: string | null } | null, values: () => Record<string, unknown> = () => ({ height: 800 })) => ({
    columnKeys: ['detail_number', 'height', 'film_id', 'cut_job'], rowKeys: ['71'], page: { current: 2, size: 50 }, grouping: null, editing,
    getEditingValues: values, getActiveCell: () => null as { rowKey: string; columnKey: string } | null,
  });

  it('film names come from the extended list when it is given', () => {
    expect(names.film(8)).toBe('Белый софт (снята)');
    expect(orderFormNames({ filmNameById: new Map([[8, 'Белый софт']]) } as never, () => undefined).film(8)).toBe('Белый софт');
  });

  it('the page is taken only when it is a sane one, with the exact run of customer rows on it', () => {
    const rows = [{ detail_id: 1 }, { detail_id: 2 }, { detail_id: 3 }, { temp_id: -1, is_placeholder: true }, { temp_id: -2, is_placeholder: true }] as never[];
    const at = (page: { current: number; size: number } | null, rowKeys: string[], editing: { rowKey: string; field: string | null } | null = null) =>
      mirroredPage({ page, rowKeys, editing }, rows);
    expect(at({ current: 1, size: 2 }, ['1', '2', '3', '-1', '-2'])).toEqual({ current: 1, size: 2, start: 0, count: 2 });
    expect(at({ current: 2, size: 2 }, ['1', '2', '3', '-1', '-2'])).toEqual({ current: 2, size: 2, start: 2, count: 1 });
    // Sorted so that the empty grid rows come first: page 1 has nothing of the customer.
    expect(at({ current: 1, size: 2 }, ['-1', '-2', '3', '2', '1'])).toEqual({ current: 1, size: 2, start: 0, count: 0 });
    expect(at({ current: 2, size: 2 }, ['-1', '-2', '3', '2', '1'])).toEqual({ current: 2, size: 2, start: 0, count: 2 });
    // The empty row being filled counts.
    expect(at({ current: 2, size: 2 }, ['1', '2', '3', '-1', '-2'], { rowKey: '-1', field: 'height' })).toEqual({ current: 2, size: 2, start: 2, count: 2 });
    expect(mirroredPage(null, rows)).toBeNull();
    expect(at(null, ['1'])).toBeNull();
    expect(at({ current: 0, size: 50 }, ['1'])).toBeNull();
    expect(at({ current: 1, size: 5000 }, ['1'])).toBeNull();
    expect(at({ current: 1.5, size: 50 }, ['1'])).toBeNull();
  });

  it('no table on screen or no open editor → nothing', () => {
    expect(mirroredEditing(null, details, names, idFor)).toEqual({ focus: null, editing: null });
    expect(mirroredEditing(table(null), details, names, idFor)).toEqual({ focus: null, editing: null });
    expect(mirroredEditing(table({ rowKey: 'gone', field: 'height' }), details, names, idFor)).toEqual({ focus: null, editing: null });
  });

  it('the open editor: live values as text and the cell the manager is in', () => {
    expect(mirroredEditing(table({ rowKey: '71', field: 'height' }), details, names, idFor)).toEqual({
      focus: { code: 'details.height', rowId: 'detail71' },
      editing: { rowId: 'detail71', values: [
        { code: 'details.n', value: '1' }, { code: 'details.height', value: '800' }, { code: 'details.film', value: 'Белый софт (снята)' },
      ] },
    });
  });

  it('a cell the customer screen has no field for gives no focus mark; a failing editor read gives saved values', () => {
    const result = mirroredEditing(table({ rowKey: '71', field: 'actions' }, () => { throw new Error('form is gone'); }), details, names, idFor);
    expect(result.focus).toBeNull();
    expect(result.editing?.values.find((item) => item.code === 'details.height')?.value).toBe('716');
  });

  it('no editor open: the cell the keyboard is in is marked, when the customer screen has such a field', () => {
    const at = (rowKey: string, columnKey: string) => ({ ...table(null), getActiveCell: () => ({ rowKey, columnKey }) });
    expect(mirroredEditing(at('71', 'film_id'), details, names, idFor)).toEqual({ focus: { code: 'details.film', rowId: 'detail71' }, editing: null });
    expect(mirroredEditing(at('71', 'actions'), details, names, idFor).focus).toBeNull();
    expect(mirroredEditing(at('71', 'cut_job'), details, names, idFor).focus).toEqual({ code: 'details.cut_job', rowId: 'detail71' });
    expect(mirroredEditing(at('gone', 'height'), details, names, idFor).focus).toBeNull();
    const broken = { ...table(null), getActiveCell: () => { throw new Error('table is gone'); } };
    expect(mirroredEditing(broken, details, names, idFor)).toEqual({ focus: null, editing: null });
  });
});

describe('presentation sources and workspace tabs', () => {
  it('each source has its page, which is the key of its workspace tab', () => {
    expect(clientScreenOrderPath('7')).toBe('/orders/edit/7');
    expect(clientScreenOrderPath('new')).toBe('/orders/create');
    expect(clientScreenOrderPath(orderShowPresentationKey(7))).toBe('/orders/show/7');
  });

  it('an order screen that unmounts with its tab open keeps the presentation; a closed tab ends it', () => {
    const tabs = ['/orders', '/orders/edit/7', '/orders/show/9'];
    expect(clientScreenUnmountAction('7', tabs)).toBe('keep');
    expect(clientScreenUnmountAction(orderShowPresentationKey(9), tabs)).toBe('keep');
    // The view page of order 7 is not open, although its edit form is.
    expect(clientScreenUnmountAction(orderShowPresentationKey(7), tabs)).toBe('end');
    expect(clientScreenUnmountAction('8', tabs)).toBe('end');
    expect(clientScreenUnmountAction('7', [])).toBe('end');
  });
});
