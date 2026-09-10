import { describe, expect, it } from 'vitest';
import { orderProductionSummaryLabel, productionSummaryFromDetails, orderProductionBadge } from './orderProductionSummary';

describe('informative ordinary-detail production summary', () => {
  it.each([
    { statuses: [6, null], expected: 'Разные этапы · без статуса: 1 из 2' },
    { statuses: [null, null], expected: 'Без статуса: 2 из 2' },
    { statuses: [6, 7], expected: 'Разные этапы · самый ранний: Закатан' },
    { statuses: [6, 6], expected: 'Закатан' },
    { statuses: [], expected: 'Нет деталей' },
  ])('labels $statuses without asserting uniform readiness', ({ statuses, expected }) => {
    expect(orderProductionSummaryLabel({ production_status_name: 'Закатан',
      ...productionSummaryFromDetails(statuses.map(production_status_id => ({ production_status_id }))),
    })).toBe(expected);
  });
  it('does not invent composition from a header alone', () => {
    expect(orderProductionSummaryLabel({ productionStatusName: 'Закатан' })).toBe('Состав не проверен');
  });
  it('excludes deleted details, not unassigned active details', () => {
    expect(productionSummaryFromDetails([
      { production_status_id: 6 }, { production_status_id: null, delete_flag: true },
      { production_status_id: null },
    ])).toEqual({ production_detail_count: 2, production_unassigned_count: 1, production_distinct_status_count: 1 });
  });
  it.each([
    { ids: [6, 7], label: 'Закатан', mixed: true },
    { ids: [6, 6], label: 'Закатан', mixed: false },
    { ids: [6, null], label: 'Без статуса', mixed: true },
    { ids: [null, null], label: 'Без статуса', mixed: false },
    { ids: [], label: 'Нет деталей', mixed: false },
  ])('compact badge for $ids keeps composition in its description', ({ ids, label, mixed }) => {
    const summary = { production_status_name: 'Закатан',
      ...productionSummaryFromDetails(ids.map(production_status_id => ({ production_status_id }))) };
    expect(orderProductionBadge(summary)).toEqual({ label, mixed, description: orderProductionSummaryLabel(summary) });
  });
  it('does not paint an unverified scalar as mixed or uniform', () => {
    expect(orderProductionBadge({ productionStatusName: 'Закатан' })).toEqual({
      label: 'Не проверен', mixed: false, description: 'Состав не проверен',
    });
  });
});
