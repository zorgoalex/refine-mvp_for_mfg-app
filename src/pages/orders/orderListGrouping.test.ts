import { describe, expect, it } from 'vitest';
import { groupOrderRows, orderDeadlineGroupKey } from './orderListWorkbench';
import { flattenOrderGroups, isOrderGroupRow } from './orderListGroupedTable';

const now = new Date(2026, 9, 27, 10, 0, 0);

describe('orders list grouping (NewLine)', () => {
  it('puts an order into a deadline group', () => {
    expect(orderDeadlineGroupKey({ planned_completion_date: '2026-10-20' }, now)).toBe('overdue');
    expect(orderDeadlineGroupKey({ planned_completion_date: '2026-10-27' }, now)).toBe('today');
    expect(orderDeadlineGroupKey({ planned_completion_date: '2026-11-03' }, now)).toBe('week');
    expect(orderDeadlineGroupKey({ planned_completion_date: '2026-11-04' }, now)).toBe('later');
    expect(orderDeadlineGroupKey({}, now)).toBe('none');
    expect(orderDeadlineGroupKey({ planned_completion_date: '2026-10-20', issue_date: '2026-10-21' }, now)).toBe('done');
  });

  it('groups deadlines in a fixed order and statuses as they appear', () => {
    const rows = [
      { order_id: 1, order_status_name: 'В работе', planned_completion_date: '2026-11-10' },
      { order_id: 2, order_status_name: 'Оформлен', planned_completion_date: '2026-10-20' },
      { order_id: 3, order_status_name: 'В работе', planned_completion_date: '2026-10-27' },
    ];
    expect(groupOrderRows(rows, 'deadline', now).map((group) => [group.label, group.rows.map((row) => row.order_id)]))
      .toEqual([['Просрочено', [2]], ['Сегодня', [3]], ['Позже', [1]]]);
    expect(groupOrderRows(rows, 'status', now).map((group) => [group.label, group.rows.map((row) => row.order_id)]))
      .toEqual([['В работе', [1, 3]], ['Оформлен', [2]]]);
  });

  it('adds a header row before each group, none without grouping', () => {
    const rows = [{ order_id: 1, order_status_name: 'А' }, { order_id: 2, order_status_name: 'Б' }];
    expect(flattenOrderGroups(groupOrderRows(rows, 'none', now))).toEqual(rows);
    const flat = flattenOrderGroups(groupOrderRows(rows, 'status', now));
    expect(flat.map((row) => (isOrderGroupRow(row) ? `#${row.label}:${row.count}` : row.order_id))).toEqual(['#А:1', 1, '#Б:1', 2]);
  });
});

describe('orders list quick periods (NewLine)', () => {
  it('computes the ranges', async () => {
    const { orderListPeriodRange } = await import('./orderListWorkbench');
    // 27.10.2026 is a Tuesday
    expect(orderListPeriodRange('today', now)).toEqual(['2026-10-27', '2026-10-27']);
    expect(orderListPeriodRange('week', now)).toEqual(['2026-10-26', '2026-11-01']);
    expect(orderListPeriodRange('30d', now)).toEqual(['2026-09-28', '2026-10-27']);
    expect(orderListPeriodRange('quarter', now)).toEqual(['2026-10-01', '2026-12-31']);
    expect(orderListPeriodRange('all', now)).toBeNull();
  });

  it('recognises the period in the current filters', async () => {
    const { orderListPeriodOf } = await import('./orderListWorkbench');
    expect(orderListPeriodOf([], now)).toBe('all');
    expect(orderListPeriodOf([
      { field: 'order_date', operator: 'gte', value: '2026-10-26' },
      { field: 'order_date', operator: 'lte', value: '2026-11-01' },
    ], now)).toBe('week');
    expect(orderListPeriodOf([
      { field: 'order_date', operator: 'gte', value: '2026-10-02' },
      { field: 'order_date', operator: 'lte', value: '2026-10-05' },
    ], now)).toBeNull();
  });
});
