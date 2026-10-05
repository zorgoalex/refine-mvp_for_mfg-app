import { describe, expect, it } from 'vitest';
import { CLIENT_SCREEN_PATH } from './clientScreenPath';
import { clientScreenWindowFeatures, pickCustomerScreen } from './openClientScreenWindow';
import { clientScreenControlModel } from './clientScreenControlModel';
import type { ClientScreenPresenterView } from './clientScreenPresenter';
import { mirroredTab, orderFormMirrorTabs, orderFormNames } from './useClientScreenOrderBridge';

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
  it('mirrors the five tabs with the labels and order of the layout the manager uses', () => {
    expect(orderFormMirrorTabs(false)).toEqual([
      { key: 'basic', label: 'Основная информация' }, { key: 'details', label: 'Детали заказа' }, { key: 'dates', label: 'Даты' },
      { key: 'finance', label: 'Финансы' }, { key: 'services', label: 'Услуги/товары' },
    ]);
    expect(orderFormMirrorTabs(true).map((tab) => `${tab.key}:${tab.label}`)).toEqual(['basic:Обзор', 'details:Состав', 'finance:Финансы', 'dates:Логистика', 'services:Услуги/товары']);
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
    ({ phase: 'idle', presentedOrderKey: null, lost: null, workstationDisabled: false, policyStale: false, ...over });

  it('offers the emergency switch-off in every tab that is not switched off — also in a tab that presents nothing', () => {
    // Tab B: nothing presented here; another browser tab may be presenting.
    expect(clientScreenControlModel(view(), '7', true)).toMatchObject({ mode: 'idle', label: 'Показать клиенту', canPresent: true, emergency: true });
    expect(clientScreenControlModel(view({ presentedOrderKey: '9', phase: 'owner' }), '7', true)).toMatchObject({ mode: 'idle', label: 'Показать этот заказ', emergency: true });
    expect(clientScreenControlModel(view({ presentedOrderKey: '7', phase: 'owner' }), '7', true)).toEqual({ mode: 'presenting', waiting: false, emergency: true });
    expect(clientScreenControlModel(view({ presentedOrderKey: '7', phase: 'claiming' }), '7', true)).toMatchObject({ mode: 'presenting', waiting: true });
    expect(clientScreenControlModel(view({ presentedOrderKey: '7', phase: 'owner', policyStale: true }), '7', true)).toMatchObject({ waiting: true });
    expect(clientScreenControlModel(view({ workstationDisabled: true, presentedOrderKey: '7' }), '7', true)).toEqual({ mode: 'workstation-off' });
  });

  it('does not offer to present while the form has no backend reference names (the customer would see dashes)', () => {
    const model = clientScreenControlModel(view(), '7', false);
    expect(model).toMatchObject({ mode: 'idle', canPresent: false, emergency: true });
    expect(model.mode === 'idle' && model.hint).toContain('справочники');
  });

  it('maps the manager tab to a mirrored tab or to nothing', () => {
    expect(['basic', 'details', 'dates', 'finance', 'services'].map(mirroredTab)).toEqual(['basic', 'details', 'dates', 'finance', 'services']);
    expect(['hdf', 'cut', 'workshops', 'requirements', 'additional', ''].map(mirroredTab)).toEqual([null, null, null, null, null, null]);
  });
});
