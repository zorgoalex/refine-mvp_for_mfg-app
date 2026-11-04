import { describe, expect, it } from 'vitest';
import { orderCutIssueLines, orderCutIssuesDetailsKey } from './OrderCutIssuesAlert';

describe('order cut issue lines', () => {
  it('groups issues by kind in a fixed order and shows before/after values', () => {
    expect(orderCutIssueLines({
      cutJobId: 1028, cutNumber: '411', name: 'Тест',
      issues: [
        { kind: 'size_changed', orderDetailId: 5, detailNumber: 5, calculated: '700×596', current: '700×600' },
        { kind: 'deleted', orderDetailId: 68666, detailNumber: 3, calculated: null, current: null },
        { kind: 'deleted', orderDetailId: 68667, detailNumber: null, calculated: null, current: null },
        { kind: 'material_changed', orderDetailId: 6, detailNumber: 6, calculated: null, current: null },
      ],
    })).toEqual([
      'удалены из заказа: №3, id 68667',
      'изменён размер: №5 (было 700×596, стало 700×600)',
      'изменён материал листа: №6',
    ]);
  });
});

describe('order cut issues details key', () => {
  const base = [
    { detail_id: 1, height: 700, width: 596, quantity: 1, sheet_material_type_id: 8 },
    { detail_id: 2, height: 400, width: 300, quantity: 2, sheet_material_type_id: 8 },
  ];
  const key = orderCutIssuesDetailsKey(base);

  it('changes when a detail is deleted, resized, re-quantified or gets another sheet material', () => {
    expect(orderCutIssuesDetailsKey(base.slice(0, 1))).not.toBe(key);
    expect(orderCutIssuesDetailsKey([{ ...base[0], width: 600 }, base[1]])).not.toBe(key);
    expect(orderCutIssuesDetailsKey([base[0], { ...base[1], quantity: 3 }])).not.toBe(key);
    expect(orderCutIssuesDetailsKey([{ ...base[0], sheet_material_type_id: 9 }, base[1]])).not.toBe(key);
  });

  it('is stable for the same details in another order and returns to the old key on restore', () => {
    expect(orderCutIssuesDetailsKey([base[1], base[0]])).toBe(key);
    expect(orderCutIssuesDetailsKey([{ ...base[0] }, { ...base[1] }])).toBe(key);
  });
});
