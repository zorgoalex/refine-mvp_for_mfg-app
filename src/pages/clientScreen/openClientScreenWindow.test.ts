import { describe, expect, it } from 'vitest';
import { CLIENT_SCREEN_PATH } from './clientScreenPath';
import { clientScreenWindowFeatures, pickCustomerScreen } from './openClientScreenWindow';
import { orderFormMirrorTabs, orderFormNames } from './useClientScreenOrderBridge';

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
