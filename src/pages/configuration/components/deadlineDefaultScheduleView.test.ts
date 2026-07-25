import { describe, expect, it } from 'vitest';
import type { DeadlineDefaultScheduleDto } from '../../../api/types/deadlineApi.types';
import {
  buildDefaultSchedulePayload,
  calculateCumulativeHints,
  canViewDeadlineDefaultSchedule,
  computePlannedCompletionDate,
  shouldApplyComputedPlannedCompletion,
} from './deadlineDefaultScheduleView';

const schedule: DeadlineDefaultScheduleDto = {
  configured: false,
  hasStoredConfiguration: false,
  version: 3,
  reserveDays: 0,
  totalProductionDays: null,
  plannedOrderDays: null,
  updatedAt: null,
  stages: [
    stage(1, 'Отрисован'),
    stage(2, 'Распилен'),
    stage(3, 'Упакован'),
  ],
};

describe('deadline default schedule view', () => {
  it('gates the read model to deadline viewers or settings managers', () => {
    expect(canViewDeadlineDefaultSchedule({ id: '1', username: 'a', role: 'admin', permissions: ['deadlines.view'] })).toBe(true);
    expect(canViewDeadlineDefaultSchedule({ id: '2', username: 'b', role: 'manager', permissions: ['orders.create'] })).toBe(false);
  });

  it('shows cumulative days from the order date', () => {
    const hints = calculateCumulativeHints(schedule, { 1: 2, 2: 3, 3: 1 });
    expect([...hints.values()]).toEqual([2, 5, 6]);
  });

  it('does not build a partial schedule payload', () => {
    expect(
      buildDefaultSchedulePayload(
        schedule,
        2,
        { 1: 2, 2: null, 3: 1 },
        'Новый цикл',
      ),
    ).toBeNull();
  });

  it('builds full replacement and calculates planned readiness', () => {
    expect(
      buildDefaultSchedulePayload(
        schedule,
        2,
        { 1: 2, 2: 3, 3: 1 },
        ' Новый цикл ',
      ),
    ).toEqual({
      expectedVersion: 3,
      reserveDays: 2,
      reason: 'Новый цикл',
      stages: [
        { productionStatusId: 1, durationDays: 2 },
        { productionStatusId: 2, durationDays: 3 },
        { productionStatusId: 3, durationDays: 1 },
      ],
    });
    expect(
      computePlannedCompletionDate('2026-12-29', {
        ...schedule,
        configured: true,
        totalProductionDays: 6,
        plannedOrderDays: 8,
      }),
    ).toBe('2027-01-06');
  });

  it('preserves the edited stage order in the replacement payload', () => {
    expect(
      buildDefaultSchedulePayload(
        {
          ...schedule,
          stages: [schedule.stages[2], schedule.stages[0], schedule.stages[1]],
        },
        0,
        { 1: 2, 2: 3, 3: 1 },
        'Меняем маршрут',
      )?.stages.map((item) => item.productionStatusId),
    ).toEqual([3, 1, 2]);
  });

  it('does not replace a manual date when the delayed schedule response arrives', () => {
    expect(shouldApplyComputedPlannedCompletion('2026-07-15', null)).toBe(false);
    expect(shouldApplyComputedPlannedCompletion(null, null)).toBe(true);
    expect(
      shouldApplyComputedPlannedCompletion('2026-07-09', '2026-07-09'),
    ).toBe(true);
  });
});

function stage(productionStatusId: number, productionStatusName: string) {
  return {
    productionStatusId,
    productionStatusName,
    productionStatusCode: null,
    sortOrder: productionStatusId,
    durationDays: null,
    cumulativeDeadlineDays: null,
  };
}
