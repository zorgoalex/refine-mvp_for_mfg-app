import { describe, expect, it } from 'vitest';
import type { CalendarOrder } from '../types/calendar';
import {
  applyCalendarFilters,
  cleanCalendarFilters,
  getCalendarActiveFilterCount,
  matchesCalendarFilters,
} from './calendarFilters';

const order = (overrides: Partial<CalendarOrder> = {}): CalendarOrder => ({
  order_id: 11445,
  order_name: 'ФК26-11445',
  order_date: '2026-08-01',
  planned_completion_date: '2026-08-05',
  version: 1,
  parts_count: 2,
  total_area: 3.2,
  paid_amount: 1000,
  client_name: 'Тестовый клиент',
  order_status_name: 'В работе',
  payment_status_name: 'Частично оплачено',
  order_details: [
    {
      material: { material_name: 'ЛДСП Дуб' },
      milling_type: { milling_type_name: 'Модерн' },
    },
    {
      material: { material_name: 'МДФ Белый' },
      milling_type: { milling_type_name: 'Выборка' },
    },
  ],
  ...overrides,
});

describe('calendarFilters', () => {
  it('uses the top quick search for order number, order id, and client in one field', () => {
    expect(matchesCalendarFilters(order(), { quickSearch: '11445' })).toBe(true);
    expect(matchesCalendarFilters(order(), { quickSearch: 'тестовый' })).toBe(true);
    expect(matchesCalendarFilters(order(), { quickSearch: 'другой клиент' })).toBe(false);
  });

  it('applies separate calendar filters by order, client, material, milling, payment, and status', () => {
    expect(matchesCalendarFilters(order(), {
      orderQuery: 'ФК26',
      clientQuery: 'клиент',
      materialName: 'дуб',
      millingTypeName: 'выборка',
      paymentStatusName: 'Частично оплачено',
      orderStatusName: 'В работе',
    })).toBe(true);

    expect(matchesCalendarFilters(order(), {
      materialName: 'шпон',
    })).toBe(false);
  });

  it('keeps filters conjunctive across orders', () => {
    const rows = [
      order({ order_id: 1, order_name: 'A-1', client_name: 'Клиент A' }),
      order({ order_id: 2, order_name: 'B-2', client_name: 'Клиент B', payment_status_name: 'Оплачено' }),
    ];

    expect(applyCalendarFilters(rows, {
      clientQuery: 'Клиент B',
      paymentStatusName: 'Оплачено',
    }).map((row) => row.order_id)).toEqual([2]);
  });

  it('trims empty values before counting active filters', () => {
    const cleaned = cleanCalendarFilters({
      quickSearch: '  ФК26 ',
      materialName: '   ',
    });

    expect(cleaned).toEqual({ quickSearch: 'ФК26' });
    expect(getCalendarActiveFilterCount(cleaned)).toBe(1);
  });
});
