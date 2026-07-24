import { describe, expect, it } from 'vitest';
import { addCalendarDays, buildDeadlineDefaultSchedule } from './deadline-default-schedule';

describe('deadline default schedule', () => {
  it('sums every previous stage and reserve', () => {
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

  it('adds calendar days without timezone drift', () => {
    expect(addCalendarDays('2026-12-29', 5)).toBe('2027-01-03');
    expect(addCalendarDays('2028-02-29', 1)).toBe('2028-03-01');
    expect(addCalendarDays('2027-02-29', 1)).toBeNull();
  });
});

function stage(productionStatusId: number, durationDays: number | null) {
  return {
    productionStatusId,
    productionStatusName: `Stage ${productionStatusId}`,
    productionStatusCode: null,
    sortOrder: productionStatusId,
    durationDays,
  };
}
