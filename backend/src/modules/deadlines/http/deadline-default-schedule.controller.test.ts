import { describe, expect, it } from 'vitest';
import { parseReplaceDeadlineDefaultScheduleRequest } from './deadline-default-schedule.controller';

describe('deadline default schedule HTTP parser', () => {
  it('accepts a full bounded replacement', () => {
    expect(
      parseReplaceDeadlineDefaultScheduleRequest({
        expectedVersion: 2,
        reserveDays: 3,
        reason: 'Новый производственный цикл',
        stages: [
          { productionStatusId: 10, durationDays: 2 },
          { productionStatusId: 20, durationDays: 4 },
        ],
      }),
    ).toEqual({
      expectedVersion: 2,
      reserveDays: 3,
      reason: 'Новый производственный цикл',
      stages: [
        { productionStatusId: 10, durationDays: 2 },
        { productionStatusId: 20, durationDays: 4 },
      ],
    });
  });

  it('accepts an explicit empty schedule with zero reserve', () => {
    expect(
      parseReplaceDeadlineDefaultScheduleRequest({
        expectedVersion: 3,
        reserveDays: 0,
        reason: 'Отключение автоматических сроков',
        stages: [],
      }),
    ).toEqual({
      expectedVersion: 3,
      reserveDays: 0,
      reason: 'Отключение автоматических сроков',
      stages: [],
    });
  });

  it.each([
    [{ expectedVersion: 0, reserveDays: 1, reason: 'reason', stages: [{ productionStatusId: 1, durationDays: 1 }] }],
    [{ expectedVersion: 1, reserveDays: -1, reason: 'reason', stages: [{ productionStatusId: 1, durationDays: 1 }] }],
    [{ expectedVersion: 1, reserveDays: 1, reason: 'reason', stages: [] }],
    [{ expectedVersion: 1, reserveDays: 1, reason: 'reason', stages: [{ productionStatusId: 1, durationDays: 3651 }] }],
  ])('rejects invalid payload %#', (body) => {
    expect(() => parseReplaceDeadlineDefaultScheduleRequest(body)).toThrow();
  });
});
