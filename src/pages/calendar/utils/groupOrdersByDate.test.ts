import { describe, expect, it } from 'vitest';
import { areAllOrdersIssued } from './groupOrdersByDate';
import type { CalendarOrder } from '../types/calendar';

const order = (patch: Partial<CalendarOrder> = {}): CalendarOrder => ({
  order_id: 1, order_name: 'Тест', order_date: '2026-09-12',
  planned_completion_date: '2026-09-12', version: 1, parts_count: 1,
  total_area: 1, paid_amount: 0, ...patch,
});

describe('areAllOrdersIssued uses the calendar DTO status name', () => {
  it('does not mark an empty day as issued', () => expect(areAllOrdersIssued([])).toBe(false));
  it.each(['Выдан', 'ВЫДАН', 'выдан', 'вЫдАн'])('recognizes %s without a legacy flag', status => {
    expect(areAllOrdersIssued([order({ order_status_name: status })])).toBe(true);
  });
  it('requires every order to be issued', () => {
    expect(areAllOrdersIssued([order({ order_status_name: 'Выдан' }), order({ order_id: 2, order_status_name: 'Новый' })])).toBe(false);
  });
  it('allows all-issued days combining the name and legacy flag', () => {
    expect(areAllOrdersIssued([order({ order_status_name: 'Выдан' }), order({ order_id: 2, is_issued: true })])).toBe(true);
  });
  it.each([{}, { order_status_name: null }, { order_status_id: 42 }, { order_status_name: '' }, { order_status_name: 'Новый' }, { is_issued: false }])(
    'does not infer issued from absent or unrelated fields: %j', patch => {
      expect(areAllOrdersIssued([order(patch)])).toBe(false);
    },
  );
  it('preserves the explicit true flag even with another status name', () => {
    expect(areAllOrdersIssued([order({ order_status_name: 'Новый', is_issued: true })])).toBe(true);
  });
  it('does not let an explicit false flag override the issued name', () => {
    expect(areAllOrdersIssued([order({ order_status_name: 'Выдан', is_issued: false })])).toBe(true);
  });
});
