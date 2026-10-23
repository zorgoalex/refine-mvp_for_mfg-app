import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/apiError';
import {
  canSeeClientOnecDocuments, clientOnecDocumentAmount, clientOnecDocumentKind, clientOnecDocumentsProblem, clientOnecDocumentStateNote,
  clientOnecGroupOptions, clientOnecMoney, clientOnecScopeNote, clientOnecTotals, clientOnecTotalsTitle,
} from './clientOnecDocumentsModel';

const having = (...permissions: string[]) => (permission: string) => permissions.includes(permission);

describe('1C documents of a client in the client card («Документы 1С»)', () => {
  it('shows the tab only with both rights', () => {
    expect(canSeeClientOnecDocuments(having('clients.onec_documents.view', 'orders.view'))).toBe(true);
    expect(canSeeClientOnecDocuments(having('clients.onec_documents.view'))).toBe(false);
    expect(canSeeClientOnecDocuments(having('orders.view', 'clients.onec_data.view'))).toBe(false);
  });

  it('formats 1C amounts without floating point and shows nothing when the backend gave no money', () => {
    expect(clientOnecMoney('12500.5')).toBe('12 500,50');
    expect(clientOnecMoney('1234567.89')).toBe('1 234 567,89');
    expect(clientOnecMoney('0.00')).toBe('0,00');
    expect(clientOnecMoney('-300')).toBe('−300,00');
    expect(clientOnecMoney(undefined)).toBe('');
    expect(clientOnecMoney(null)).toBe('');
    expect(clientOnecMoney('abc')).toBe('');
    expect(clientOnecDocumentAmount({ amount: '100.00', currency: 'KZT' })).toBe('100,00');
    expect(clientOnecDocumentAmount({ amount: '100.00', currency: 'USD' })).toBe('100,00 USD');
    expect(clientOnecDocumentAmount({ currency: 'USD' })).toBe('');
  });

  it('names kinds and marks documents that are not part of the totals', () => {
    expect(clientOnecDocumentKind('sales_shipment')).toBe('Расходная накладная');
    expect(clientOnecDocumentKind('something_new')).toBe('something_new');
    expect(clientOnecDocumentStateNote('posted')).toBeNull();
    expect(clientOnecDocumentStateNote('not_posted')).toBe('не проведён');
    expect(clientOnecDocumentStateNote('deleted')).toBe('помечен на удаление');
    expect(clientOnecDocumentStateNote('missing')).toBe('нет в 1С');
  });

  it('counts documents on the group buttons', () => {
    expect(clientOnecGroupOptions({ orders: 3, shipments: 2, receipts: 4, refunds: 0 })).toEqual([
      { value: 'all', label: 'Все (9)' },
      { value: 'orders', label: 'Заказы покупателя (3)' },
      { value: 'shipments', label: 'Отгрузки (2)' },
      { value: 'receipts', label: 'Поступления денег (4)' },
      { value: 'refunds', label: 'Возвраты денег (0)' },
    ]);
  });

  it('calls a positive balance a debt and a negative one an advance', () => {
    const base = { currency: 'KZT', ordered: '1000.00', shipped: '900.00', received: '700.00', refunded: '50.00' };
    expect(clientOnecTotals({ ...base, balance: '250.00' }).at(-1)).toEqual({ label: 'Долг по отгрузкам', value: '250,00' });
    expect(clientOnecTotals({ ...base, balance: '-250.00' }).at(-1)).toEqual({ label: 'Аванс', value: '250,00' });
    expect(clientOnecTotals({ ...base, balance: '0.00' }).map((item) => item.label)).toEqual(['Заказано', 'Отгружено', 'Поступило', 'Возвращено', 'Долг по отгрузкам']);
  });

  it('always names the currency of a totals block', () => {
    expect(clientOnecTotalsTitle('KZT')).toBe('Итог по 1С, тенге');
    expect(clientOnecTotalsTitle('USD')).toBe('Итог по 1С, USD');
    expect(clientOnecTotalsTitle(null)).toBe('Итог по 1С, валюта неизвестна');
    const tab = readFileSync(new URL('./ClientOnecDocumentsTab.tsx', import.meta.url), 'utf8');
    expect(tab).toContain('title={clientOnecTotalsTitle(summary.currency)}');
  });

  it('explains a limited view and the reasons the list is not shown', () => {
    expect(clientOnecScopeNote('all')).toBeNull();
    expect(clientOnecScopeNote('own')).toContain('к вашим заказам');
    expect(clientOnecDocumentsProblem(new ApiError({ status: 403, code: 'PERMISSION_DENIED', message: 'x' }))).toContain('Недостаточно прав');
    expect(clientOnecDocumentsProblem(new ApiError({ status: 404, code: 'NOT_FOUND', message: 'x' }))).toContain('после обновления сервера');
    expect(clientOnecDocumentsProblem(new ApiError({ status: 404, code: 'CLIENT_NOT_FOUND', message: 'x' }))).toContain('Не удалось');
    expect(clientOnecDocumentsProblem(new Error('x'))).toContain('Не удалось');
  });

  it('the tab leaves visibility and money to the backend and never adds its totals to the ERP ones (source guard)', () => {
    const tab = readFileSync(new URL('./ClientOnecDocumentsTab.tsx', import.meta.url), 'utf8');
    expect(tab).toContain('partyContactsApi.clientOnecDocuments(');
    expect(tab).not.toMatch(/clientOrdersApi|ClientOrdersTab|clientOrdersTotals/);
    expect(tab).not.toMatch(/can\(|permissions/);
    expect(tab).toContain("from '../../ui/tooltipDelay'");
    const card = readFileSync(new URL('./show.tsx', import.meta.url), 'utf8');
    expect(card).toContain('canSeeClientOnecDocuments(can)');
  });
});
