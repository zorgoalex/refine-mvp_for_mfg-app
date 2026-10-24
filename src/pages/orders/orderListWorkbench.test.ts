import { describe, expect, it } from 'vitest';
import { orderDeadlineHint, orderListWorkbenchDefaultOrder, orderStatusTone, paymentStatusTone } from './orderListWorkbench';

describe('workbench order list tones', () => {
  it('maps order statuses to calm tones and keeps unknown ones active', () => {
    expect(orderStatusTone('Готов к выдаче')).toBe('ready');
    expect(orderStatusTone('Предварительный')).toBe('neutral');
    expect(orderStatusTone('Выдан')).toBe('neutral');
    expect(orderStatusTone('В производстве')).toBe('active');
    expect(orderStatusTone('Отменён')).toBe('danger');
    expect(orderStatusTone(null)).toBe('neutral');
  });

  it('maps payment statuses without confusing «Не оплачен» with «Оплачен»', () => {
    expect(paymentStatusTone('Не оплачен')).toBe('danger');
    expect(paymentStatusTone('Частично оплачен')).toBe('warning');
    expect(paymentStatusTone('Оплачен')).toBe('ready');
    expect(paymentStatusTone('В долг')).toBe('neutral');
    expect(paymentStatusTone(undefined)).toBe('neutral');
  });
});

describe('orderDeadlineHint', () => {
  const now = new Date(2026, 9, 1, 15, 30);

  it('counts calendar days from today', () => {
    expect(orderDeadlineHint({ planned_completion_date: '2026-10-08' }, now)).toEqual({ text: 'через 7 дн.', tone: 'neutral' });
    expect(orderDeadlineHint({ planned_completion_date: '2026-10-03' }, now)).toEqual({ text: 'через 2 дн.', tone: 'warning' });
    expect(orderDeadlineHint({ planned_completion_date: '2026-10-02' }, now)).toEqual({ text: 'завтра', tone: 'warning' });
    expect(orderDeadlineHint({ planned_completion_date: '2026-10-01' }, now)).toEqual({ text: 'сегодня', tone: 'warning' });
    expect(orderDeadlineHint({ planned_completion_date: '2026-09-28' }, now)).toEqual({ text: 'просрочено 3 дн.', tone: 'danger' });
  });

  it('never calls an issued or completed order overdue', () => {
    expect(orderDeadlineHint({ planned_completion_date: '2026-09-01', issue_date: '2026-09-02' }, now)).toEqual({ text: 'выдан', tone: 'neutral' });
    expect(orderDeadlineHint({ planned_completion_date: '2026-09-01', completion_date: '2026-09-03' }, now)).toEqual({ text: 'выполнен', tone: 'neutral' });
  });

  it('returns nothing without a planned date', () => {
    expect(orderDeadlineHint({ planned_completion_date: null }, now)).toBeNull();
    expect(orderDeadlineHint({ planned_completion_date: 'нет' }, now)).toBeNull();
  });
});

describe('orderListWorkbenchDefaultOrder', () => {
  it('reorders without adding or dropping columns', () => {
    const keys = ['order_name', 'doweling_order_name', 'cut_numbers', 'order_date', 'client_name', 'notes',
      'planned_completion_date', 'order_status_name', 'payment_status_name', 'final_amount', 'actions'];
    const ordered = orderListWorkbenchDefaultOrder(keys);

    expect([...ordered].sort()).toEqual([...keys].sort());
    expect(ordered.slice(0, 6)).toEqual([
      'order_name', 'client_name', 'order_status_name', 'planned_completion_date', 'final_amount', 'payment_status_name',
    ]);
    expect(ordered.slice(6)).toEqual(['doweling_order_name', 'cut_numbers', 'order_date', 'notes', 'actions']);
  });

  it('skips columns hidden by permissions or feature flags', () => {
    expect(orderListWorkbenchDefaultOrder(['order_name', 'notes', 'actions'])).toEqual(['order_name', 'notes', 'actions']);
  });
});
