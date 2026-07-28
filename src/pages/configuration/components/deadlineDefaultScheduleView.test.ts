import { describe, expect, it } from 'vitest';
import type { DeadlineDefaultScheduleDto } from '../../../api/types/deadlineApi.types';
import {
  buildDefaultSchedulePayload,
  calculateCumulativeHints,
  calculateScheduleDraft,
  canViewDeadlineDefaultSchedule,
  computePlannedCompletionDate,
  isDeadlineScheduleDraftComplete,
  shouldApplyComputedPlannedCompletion,
} from './deadlineDefaultScheduleView';

const schedule: DeadlineDefaultScheduleDto = {
  configured: false,
  hasStoredConfiguration: false,
  version: 3,
  reserveDays: 0,
  transitionsOrder: {
    drawn: ['cut'],
    cut: ['packed'],
  },
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
    const hints = calculateCumulativeHints(
      schedule,
      { 1: 2, 2: 3, 3: 1 },
    );
    expect([...hints.values()]).toEqual([2, 5, 6]);
  });

  it('treats zero-day stages as a complete schedule', () => {
    const calculation = calculateScheduleDraft(
      schedule,
      { 1: 0, 2: 0, 3: 0 },
    );

    expect([...calculation.cumulativeHints.values()]).toEqual([0, 0, 0]);
    expect(calculation.totalProductionDays).toBe(0);
    expect(isDeadlineScheduleDraftComplete(calculation, 0)).toBe(true);
  });

  it('uses the longest incoming transition path at a merge', () => {
    const calculation = calculateScheduleDraft(
      {
        ...schedule,
        transitionsOrder: {
          drawn: ['packed'],
          cut: ['packed'],
        },
      },
      { 1: 2, 2: 5, 3: 1 },
    );

    expect([...calculation.cumulativeHints.values()]).toEqual([2, 5, 6]);
    expect(calculation.totalProductionDays).toBe(6);
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
        { productionStatusId: 1, durationDays: 2, parallelWithPrevious: false },
        { productionStatusId: 2, durationDays: 3, parallelWithPrevious: false },
        { productionStatusId: 3, durationDays: 1, parallelWithPrevious: false },
      ],
    });
    expect(
      computePlannedCompletionDate('2026-12-29', {
        ...schedule,
        configured: true,
        reserveDays: 2,
        totalProductionDays: 6,
        plannedOrderDays: 8,
        stages: [
          { ...stage(1, 'Отрисован'), durationDays: 2 },
          { ...stage(2, 'Распилен'), durationDays: 3 },
          { ...stage(3, 'Упакован'), durationDays: 1 },
        ],
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

  it('calculates readiness only from stages present in an order', () => {
    const configuredSchedule: DeadlineDefaultScheduleDto = {
      ...schedule,
      configured: true,
      reserveDays: 1,
      stages: [
        { ...stage(1, 'Отрисован'), durationDays: 3 },
        { ...stage(2, 'Распилен'), durationDays: 4 },
        { ...stage(3, 'Упакован'), durationDays: 8 },
      ],
    };

    expect(
      computePlannedCompletionDate(
        '2026-07-01',
        configuredSchedule,
        [2],
      ),
    ).toBe('2026-07-06');
    expect(
      computePlannedCompletionDate('2026-07-01', configuredSchedule, []),
    ).toBeNull();
  });

  it('does not add a stage that is absent from the order route', () => {
    const configuredSchedule: DeadlineDefaultScheduleDto = {
      ...schedule,
      configured: true,
      reserveDays: 0,
      stages: [
        { ...stage(1, 'Отрисован'), durationDays: 3 },
        { ...stage(2, 'Распилен'), durationDays: 20 },
        { ...stage(3, 'Упакован'), durationDays: 8 },
      ],
    };

    expect(
      computePlannedCompletionDate(
        '2026-07-01',
        configuredSchedule,
        [1, 3],
      ),
    ).toBe('2026-07-09');
  });

  it('fails closed when transitions contain a cycle', () => {
    const calculation = calculateScheduleDraft(
      {
        ...schedule,
        transitionsOrder: {
          drawn: ['cut'],
          cut: ['drawn'],
        },
      },
      { 1: 2, 2: 3, 3: 1 },
    );

    expect(calculation.hasCycle).toBe(true);
    expect(calculation.totalProductionDays).toBeNull();
    expect([...calculation.cumulativeHints.values()]).toEqual([null, null, null]);
  });
});

function stage(productionStatusId: number, productionStatusName: string) {
  return {
    productionStatusId,
    productionStatusName,
    productionStatusCode:
      productionStatusId === 1
        ? 'drawn'
        : productionStatusId === 2
          ? 'cut'
          : 'packed',
    sortOrder: productionStatusId,
    durationDays: null,
    cumulativeDeadlineDays: null,
    parallelWithPrevious: false,
  };
}
