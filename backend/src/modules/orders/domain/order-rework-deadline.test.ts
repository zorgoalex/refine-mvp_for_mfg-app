import { describe, expect, it } from 'vitest';
import type { DeadlineDefaultScheduleDto } from '../../deadlines/dto/deadline-default-schedule.dto';
import {
  almatyToday,
  parseReworkPlannedCompletionDate,
  reworkRemainingStageIds,
  suggestReworkPlannedCompletion,
} from './order-rework-deadline';

function schedule(
  stages: Array<[id: number, code: string, days: number | null]>,
  transitionsOrder: Record<string, string[]>,
  reserveDays = 0,
): DeadlineDefaultScheduleDto {
  return {
    configured: stages.every(([, , days]) => days !== null),
    hasStoredConfiguration: true,
    version: 1,
    reserveDays,
    transitionsOrder,
    totalProductionDays: null,
    plannedOrderDays: null,
    updatedAt: null,
    stages: stages.map(([id, code, days], index) => ({
      productionStatusId: id, productionStatusName: code, productionStatusCode: code, sortOrder: index * 10,
      durationDays: days, parallelWithPrevious: false, cumulativeDeadlineDays: null,
    })),
  };
}

// drawn(1) → cut(2) → drilled(3) → packed(7)
const linear = schedule([[1, 'drawn', 2], [2, 'cut', 1], [3, 'drilled', 3], [7, 'packed', 1]],
  { drawn: ['cut'], cut: ['drilled'], drilled: ['packed'] }, 2);

describe('rework round deadline (plan 1.1 §4)', () => {
  it('remaining stages = return stages + everything reachable from them in the transition graph', () => {
    expect(reworkRemainingStageIds(linear, [2])).toEqual([2, 3, 7]);
    expect(reworkRemainingStageIds(linear, [7])).toEqual([7]);
    // Incomparable branches A→C, B→D, returns into A and B: both branches are kept.
    const branches = schedule([[10, 'A', 1], [11, 'B', 1], [12, 'C', 1], [13, 'D', 1], [14, 'E', 1]],
      { A: ['C'], B: ['D'] });
    expect(reworkRemainingStageIds(branches, [10, 11])).toEqual([10, 11, 12, 13]);
  });

  it('display order of stages does not change the result', () => {
    const shuffled = { ...linear, stages: [...linear.stages].reverse() };
    const base = suggestReworkPlannedCompletion({ schedule: linear, returnStageIds: [2], startDate: '2026-10-27' });
    const other = suggestReworkPlannedCompletion({ schedule: shuffled, returnStageIds: [2], startDate: '2026-10-27' });
    expect(other.suggestedDate).toBe(base.suggestedDate);
  });

  it('suggests start date + days of the remaining path + reserve, with the existing schedule calculator', () => {
    // cut(1) → drilled(3) → packed(1) = 5 days + reserve 2 = 7.
    expect(suggestReworkPlannedCompletion({ schedule: linear, returnStageIds: [2], startDate: '2026-10-27' }))
      .toMatchObject({ suggestedDate: '2026-11-03', plannedOrderDays: 7, stageIds: [2, 3, 7] });
  });

  it('linear schema without a graph: stages from the earliest return point on, linear calculation with reserve', () => {
    // A(2) → B(3) → C(4), no transitions, reserve 1; return into B: B + C = 7 days + 1.
    const plain = schedule([[1, 'A', 2], [2, 'B', 3], [3, 'C', 4]], {}, 1);
    expect(reworkRemainingStageIds(plain, [2])).toEqual([2, 3]);
    expect(suggestReworkPlannedCompletion({ schedule: plain, returnStageIds: [2], startDate: '2026-10-27' }))
      .toMatchObject({ suggestedDate: '2026-11-04', plannedOrderDays: 8, stageIds: [2, 3] });
    // Parallel group: C runs with B → max(3, 4) = 4 days + 1.
    const parallel = { ...plain, stages: plain.stages.map((stage) => (stage.productionStatusId === 3 ? { ...stage, parallelWithPrevious: true } : stage)) };
    expect(suggestReworkPlannedCompletion({ schedule: parallel, returnStageIds: [2], startDate: '2026-10-27' }).plannedOrderDays).toBe(5);
  });

  it('order workshops narrow the stages (as the order form)', () => {
    expect(reworkRemainingStageIds(linear, [1], [1, 7])).toEqual([1, 7]);
  });

  it('no suggestion when the schedule is not filled or the stage is outside it → manual date', () => {
    const empty = schedule([[1, 'drawn', null], [2, 'cut', null]], { drawn: ['cut'] });
    expect(suggestReworkPlannedCompletion({ schedule: empty, returnStageIds: [1], startDate: '2026-10-27' }).suggestedDate).toBeNull();
    expect(suggestReworkPlannedCompletion({ schedule: linear, returnStageIds: [99], startDate: '2026-10-27' }).suggestedDate).toBeNull();
  });

  it('validates the requested date: real date, not in the past, within the limit', () => {
    expect(parseReworkPlannedCompletionDate(undefined, '2026-10-27')).toBeNull();
    expect(parseReworkPlannedCompletionDate('2026-10-27', '2026-10-27')).toBe('2026-10-27');
    expect(() => parseReworkPlannedCompletionDate('2026-10-26', '2026-10-27')).toThrow(/раньше/);
    expect(() => parseReworkPlannedCompletionDate('27.10.2026', '2026-10-27')).toThrow(/датой/);
    expect(() => parseReworkPlannedCompletionDate('2040-01-01', '2026-10-27')).toThrow(/далеко/);
  });

  it('today is the Almaty business day', () => {
    expect(almatyToday(new Date('2026-10-27T20:30:00Z'))).toBe('2026-10-28');
  });
});
