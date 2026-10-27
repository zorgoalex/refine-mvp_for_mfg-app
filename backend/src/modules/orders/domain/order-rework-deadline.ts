import {
  calculateApplicableDeadlineSchedule,
  MAX_DEADLINE_DEFAULT_SCHEDULE_DAYS,
} from '../../deadlines/domain/deadline-default-schedule';
import type { DeadlineDefaultScheduleDto } from '../../deadlines/dto/deadline-default-schedule.dto';
import { ApiError } from '../../../common/errors/api-error';

/**
 * «Переделка» 1.1 — срок готовности круга по «Схеме этапов и сроки» (план 2026-10-27-order-rework-deadlines-plan v7, §4).
 * Оставшиеся этапы круга = этапы возврата всех деталей круга + всё, что достижимо из них по графу переходов схемы
 * (несравнимые ветви не теряются). Срок считает существующий калькулятор схемы — своей арифметики нет.
 */
export interface ReworkDeadlineSuggestion {
  /** Предложенный срок (YYYY-MM-DD) или null — схема не заполнена / этапы вне схемы → срок вручную. */
  suggestedDate: string | null;
  plannedOrderDays: number | null;
  /** Этапы, по которым считали (id), — для подсказки и аудита. */
  stageIds: number[];
}

export function reworkRemainingStageIds(
  schedule: Pick<DeadlineDefaultScheduleDto, 'stages' | 'transitionsOrder'>,
  returnStageIds: Iterable<number>,
  orderWorkshopStageIds: Iterable<number> = [],
): number[] {
  const byId = new Map(schedule.stages.map((stage) => [stage.productionStatusId, stage]));
  const idByCode = new Map(
    schedule.stages
      .filter((stage) => stage.productionStatusCode)
      .map((stage) => [stage.productionStatusCode as string, stage.productionStatusId]),
  );
  const reached = new Set<number>();
  const queue: number[] = [];
  if (!hasTransitionGraph(schedule)) {
    // Linear schema (no graph): every stage from the earliest return point on, in schedule order (§4).
    const returns = new Set(returnStageIds);
    const first = schedule.stages.findIndex((stage) => returns.has(stage.productionStatusId));
    if (first >= 0) for (const stage of schedule.stages.slice(first)) reached.add(stage.productionStatusId);
  }
  for (const id of hasTransitionGraph(schedule) ? returnStageIds : []) {
    if (byId.has(id) && !reached.has(id)) {
      reached.add(id);
      queue.push(id);
    }
  }
  const edges = schedule.transitionsOrder ?? {};
  while (queue.length > 0) {
    const code = byId.get(queue.shift() as number)?.productionStatusCode;
    if (!code) continue;
    for (const nextCode of edges[code] ?? []) {
      const nextId = idByCode.get(nextCode);
      if (nextId !== undefined && !reached.has(nextId)) {
        reached.add(nextId);
        queue.push(nextId);
      }
    }
  }
  // As in the order form: when the order has workshops, only their stages apply.
  const workshops = new Set(orderWorkshopStageIds);
  const applicable = workshops.size > 0 ? [...reached].filter((id) => workshops.has(id)) : [...reached];
  // Stable output in schedule order (the calculation itself does not depend on it).
  return schedule.stages.map((stage) => stage.productionStatusId).filter((id) => applicable.includes(id));
}

export function suggestReworkPlannedCompletion(input: {
  schedule: DeadlineDefaultScheduleDto;
  returnStageIds: Iterable<number>;
  orderWorkshopStageIds?: Iterable<number>;
  /** Дата старта круга (YYYY-MM-DD, Asia/Almaty). */
  startDate: string;
}): ReworkDeadlineSuggestion {
  const stageIds = reworkRemainingStageIds(input.schedule, input.returnStageIds, input.orderWorkshopStageIds);
  if (!input.schedule.configured || stageIds.length === 0) return { suggestedDate: null, plannedOrderDays: null, stageIds };
  if (input.schedule.stages.some((stage) => stageIds.includes(stage.productionStatusId) && stage.durationDays === null)) {
    return { suggestedDate: null, plannedOrderDays: null, stageIds };
  }
  const calculation = calculateApplicableDeadlineSchedule(
    {
      reserveDays: input.schedule.reserveDays,
      stages: input.schedule.stages.map((stage) => ({
        productionStatusId: stage.productionStatusId,
        productionStatusCode: stage.productionStatusCode,
        durationDays: stage.durationDays ?? 0,
        parallelWithPrevious: stage.parallelWithPrevious,
      })),
      // No graph → the calculator's linear mode (parallel groups and reserve as in the order form).
      transitionsOrder: hasTransitionGraph(input.schedule) ? input.schedule.transitionsOrder : undefined,
    },
    stageIds,
  );
  if (!calculation) return { suggestedDate: null, plannedOrderDays: null, stageIds };
  return {
    suggestedDate: addDays(input.startDate, calculation.plannedOrderDays),
    plannedOrderDays: calculation.plannedOrderDays,
    stageIds,
  };
}

/** The schema has a transition graph (`transitionsOrder` with at least one edge); otherwise it is linear. */
function hasTransitionGraph(schedule: Pick<DeadlineDefaultScheduleDto, 'transitionsOrder'>): boolean {
  return Object.values(schedule.transitionsOrder ?? {}).some((next) => Array.isArray(next) && next.length > 0);
}

/** Validates the requested round deadline: a date, not before today, not later than the schedule limit. */
export function parseReworkPlannedCompletionDate(value: unknown, today: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new ApiError(422, 'ORDER_REWORK_PLANNED_COMPLETION_INVALID', 'Укажите срок готовности датой');
  }
  if (value < today) {
    throw new ApiError(422, 'ORDER_REWORK_PLANNED_COMPLETION_IN_PAST', 'Срок готовности не может быть раньше сегодняшнего дня');
  }
  if (value > addDays(today, MAX_DEADLINE_DEFAULT_SCHEDULE_DAYS)) {
    throw new ApiError(422, 'ORDER_REWORK_PLANNED_COMPLETION_TOO_FAR', 'Срок готовности слишком далеко');
  }
  return value;
}

/** Today in Asia/Almaty (the business day of the stage calendar). */
export function almatyToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Almaty', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
