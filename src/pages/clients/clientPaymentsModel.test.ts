import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/apiError';
import { CLIENT_PAYMENTS_PERMISSIONS, canSeeClientPayments, clientPaymentsProblem, clientPaymentsScopeNote, clientPaymentsTotals } from './clientPaymentsModel';

describe('payments of a client in the client card («Платежи»)', () => {
  it('the tab is shown only with every right the backend checks', () => {
    expect(canSeeClientPayments(() => true)).toBe(true);
    for (const missing of CLIENT_PAYMENTS_PERMISSIONS) {
      expect(canSeeClientPayments((permission) => permission !== missing)).toBe(false);
    }
  });

  it('totals of the tab: the number of payments and their sum over all pages', () => {
    const totals = clientPaymentsTotals({ pagination: { page: 1, pageSize: 20, total: 28, totalPages: 2 }, summary: { amount: 2750 } });
    expect(totals.map((item) => item.label)).toEqual(['Платежей', 'Сумма']);
    expect(totals[0].value).toBe('28');
    expect(totals[1].value).toMatch(/^2\s750,00$/);
  });

  it('tells a user limited to his own orders that the list and the sum are only of his orders', () => {
    expect(clientPaymentsScopeNote('own')).toContain('только платежи по вашим заказам');
    expect(clientPaymentsScopeNote('restricted')).toContain('к которым у вас есть доступ');
    expect(clientPaymentsScopeNote('restricted')).not.toContain('вашим заказам');
    expect(clientPaymentsScopeNote('all')).toBeNull();
  });

  it('explains why the list is not shown', () => {
    expect(clientPaymentsProblem(new ApiError({ status: 403, code: 'PERMISSION_DENIED', message: 'x' }))).toContain('Недостаточно прав');
    expect(clientPaymentsProblem(new ApiError({ status: 404, code: 'NOT_FOUND', message: 'x' }))).toContain('после обновления сервера');
    expect(clientPaymentsProblem(new ApiError({ status: 404, code: 'CLIENT_NOT_FOUND', message: 'x' }))).toContain('Не удалось загрузить');
    expect(clientPaymentsProblem(new Error('network'))).toContain('Не удалось загрузить');
  });
});
