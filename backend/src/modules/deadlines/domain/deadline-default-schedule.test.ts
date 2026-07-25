import { describe, expect, it } from 'vitest';
import {
  addCalendarDays,
  buildDeadlineDefaultSchedule,
  calculateApplicableDeadlineSchedule,
} from './deadline-default-schedule';

describe('deadline default schedule', () => {
  it('sums sequential stage groups and reserve', () => {
    expect(
      buildDeadlineDefaultSchedule({
        version: 4,
        reserveDays: 2,
        updatedAt: null,
        stages: [
          stage(1, 2),
          stage(2, 3),
          stage(3, 1),
        ],
      }),
    ).toMatchObject({
      configured: true,
      totalProductionDays: 6,
      plannedOrderDays: 8,
      stages: [
        { productionStatusId: 1, cumulativeDeadlineDays: 2 },
        { productionStatusId: 2, cumulativeDeadlineDays: 5 },
        { productionStatusId: 3, cumulativeDeadlineDays: 6 },
      ],
    });
  });

  it('fails closed when any active stage has no duration', () => {
    const schedule = buildDeadlineDefaultSchedule({
      version: 1,
      reserveDays: 2,
      updatedAt: null,
      stages: [stage(1, 2), stage(2, null), stage(3, 1)],
    });

    expect(schedule.configured).toBe(false);
    expect(schedule.totalProductionDays).toBeNull();
    expect(schedule.plannedOrderDays).toBeNull();
    expect(schedule.stages.map((item) => item.cumulativeDeadlineDays)).toEqual([2, null, null]);
  });

  it('fails closed when the production-status catalog drifted', () => {
    const schedule = buildDeadlineDefaultSchedule({
      version: 2,
      reserveDays: 1,
      updatedAt: null,
      catalogAligned: false,
      stages: [stage(1, 2), stage(2, 3)],
    });

    expect(schedule.configured).toBe(false);
    expect(schedule.plannedOrderDays).toBeNull();
  });

  it('accepts zero-day stages without marking the schedule incomplete', () => {
    const schedule = buildDeadlineDefaultSchedule({
      version: 3,
      reserveDays: 0,
      updatedAt: null,
      stages: [stage(1, 0), stage(2, 0), stage(3, 2)],
    });

    expect(schedule.configured).toBe(true);
    expect(schedule.stages.map((item) => item.cumulativeDeadlineDays)).toEqual([0, 0, 2]);
    expect(schedule.plannedOrderDays).toBe(2);
  });

  it('uses the longest duration for parallel stages', () => {
    const schedule = buildDeadlineDefaultSchedule({
      version: 4,
      reserveDays: 1,
      updatedAt: null,
      stages: [
        stage(1, 2),
        stage(2, 5, true),
        stage(3, 1),
      ],
    });

    expect(schedule.configured).toBe(true);
    expect(schedule.stages.map((item) => item.cumulativeDeadlineDays)).toEqual([2, 5, 6]);
    expect(schedule.totalProductionDays).toBe(6);
    expect(schedule.plannedOrderDays).toBe(7);
  });

  it('collapses stages that are absent from a concrete order route', () => {
    const result = calculateApplicableDeadlineSchedule(
      {
        reserveDays: 2,
        stages: [
          stageDefinition(1, 3),
          stageDefinition(2, 5, true),
          stageDefinition(3, 4),
          stageDefinition(4, 2),
        ],
      },
      [2, 4],
    );

    expect(result).not.toBeNull();
    expect(result?.totalProductionDays).toBe(7);
    expect(result?.plannedOrderDays).toBe(9);
    expect([...result!.stageDeadlineDaysByProductionStatusId.entries()]).toEqual([
      [2, 5],
      [4, 7],
    ]);
  });

  it('does not calculate an automatic date when the order has no stages', () => {
    expect(
      calculateApplicableDeadlineSchedule(
        { reserveDays: 2, stages: [stageDefinition(1, 3)] },
        [],
      ),
    ).toBeNull();
  });

  it('adds calendar days without timezone drift', () => {
    expect(addCalendarDays('2026-12-29', 5)).toBe('2027-01-03');
    expect(addCalendarDays('2028-02-29', 1)).toBe('2028-03-01');
    expect(addCalendarDays('2027-02-29', 1)).toBeNull();
  });
});

function stage(
  productionStatusId: number,
  durationDays: number | null,
  parallelWithPrevious = false,
) {
  return {
    productionStatusId,
    productionStatusName: `Stage ${productionStatusId}`,
    productionStatusCode: null,
    sortOrder: productionStatusId,
    durationDays,
    parallelWithPrevious,
  };
}

function stageDefinition(
  productionStatusId: number,
  durationDays: number,
  parallelWithPrevious = false,
) {
  return { productionStatusId, durationDays, parallelWithPrevious };
}
