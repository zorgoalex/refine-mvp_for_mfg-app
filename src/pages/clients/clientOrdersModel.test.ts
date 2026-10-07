import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/apiError';
import { clientOrderMoney, clientOrderNumber, clientOrdersProblem, clientOrdersScopeNote, clientOrdersTotals } from './clientOrdersModel';

const pagination = { page: 1, pageSize: 20, total: 37, totalPages: 2 };

describe('orders of a client in the client card («Документы ERP»)', () => {
  it('shows money only when the backend gave it', () => {
    expect(clientOrderMoney(12500)).toMatch(/^12\s500,00$/);
    expect(clientOrderMoney(0)).toBe('0,00');
    expect(clientOrderMoney(null)).toBe('');
    expect(clientOrderMoney(undefined)).toBe('');
  });

  it('names an order by its full number, else its name, else its id', () => {
    expect(clientOrderNumber({ fullNumber: 'П-12-230725', orderName: '230725', orderId: 5 })).toBe('П-12-230725');
    expect(clientOrderNumber({ fullNumber: null, orderName: '230725', orderId: 5 })).toBe('230725');
    expect(clientOrderNumber({ fullNumber: '', orderName: '', orderId: 5 })).toBe('#5');
  });

  it('totals of the tab: the number of orders, and money only with the summary of the backend', () => {
    expect(clientOrdersTotals({ pagination })).toEqual([{ label: 'Заказов', value: '37' }]);
    const withMoney = clientOrdersTotals({ pagination, summary: { finalAmount: 1000, paidAmount: 400, debtAmount: 600 } });
    expect(withMoney.map((item) => item.label)).toEqual(['Заказов', 'Сумма', 'Оплачено', 'Долг']);
    expect(withMoney[3].value).toBe('600,00');
  });

  it('tells a user limited to his own orders that the list and the totals are only his', () => {
    expect(clientOrdersScopeNote('own')).toContain('только ваши заказы');
    expect(clientOrdersScopeNote('all')).toBeNull();
  });

  it('explains why the list is not shown', () => {
    expect(clientOrdersProblem(new ApiError({ status: 403, code: 'PERMISSION_DENIED', message: 'x' }))).toContain('Недостаточно прав');
    expect(clientOrdersProblem(new ApiError({ status: 404, code: 'NOT_FOUND', message: 'x' }))).toContain('после обновления сервера');
    expect(clientOrdersProblem(new Error('network'))).toContain('Не удалось загрузить');
  });
});
