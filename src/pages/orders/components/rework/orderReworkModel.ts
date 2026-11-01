import type { OrderReworkAction, OrderReworkReason } from '../../../../api/orderReworkApi';

/** Pure helpers of the «Переделка» UI (tested without a DOM). */

export interface ReworkDetailRow {
  id: number;
  detailNumber: number | null;
  name: string;
  productionStatusId: number | null;
  productionRound: number;
}

export interface ReworkStageOption {
  id: number;
  name: string;
  sortOrder: number;
  code: string | null;
  isActive: boolean;
}

export function reworkActionLabel(action: OrderReworkAction, openRoundNo: number | null): string {
  if (action === 'return') return 'Вернуть в переделку';
  if (action === 'start_in_production') return 'Переделка деталей';
  return `Добавить детали в переделку ·${openRoundNo ?? ''}`.trim();
}

/** Mirrors the backend rule: an active stage earlier than the detail's current one, not «Выдан» or later. */
export function isReworkTargetAllowed(
  target: ReworkStageOption,
  current: ReworkStageOption | undefined,
  stages: readonly ReworkStageOption[],
): boolean {
  if (!current || !target.isActive || target.sortOrder >= current.sortOrder) return false;
  const issued = stages.find((stage) => stage.code === 'issued');
  return !issued || target.sortOrder < issued.sortOrder;
}

export type ReworkRequestResult =
  | {
    ok: true;
    body: {
      reasonId?: number;
      comment?: string | null;
      plannedCompletionDate?: string;
      details: Array<{ detailId: number; productionStatusId: number }>;
    };
  }
  | { ok: false; message: string | null };

export function buildReworkRequest(input: {
  selected: ReadonlySet<number>;
  commonStage: number | undefined;
  perRow: Readonly<Record<number, number | undefined>>;
  details: readonly ReworkDetailRow[];
  stageById: ReadonlyMap<number, ReworkStageOption>;
  reasonId: number | undefined;
  comment: string;
  needsReason: boolean;
  reasons: readonly OrderReworkReason[];
  /** «Переделка» 1.1: the round deadline (YYYY-MM-DD) and whether it is required («Вернуть в переделку»). */
  plannedCompletionDate?: string | null;
  deadlineRequired?: boolean;
}): ReworkRequestResult {
  if (input.selected.size === 0) return { ok: false, message: 'Выберите детали' };
  const stages = [...input.stageById.values()];
  const items: Array<{ detailId: number; productionStatusId: number }> = [];
  for (const detail of input.details) {
    if (!input.selected.has(detail.id)) continue;
    const target = input.perRow[detail.id] ?? input.commonStage;
    if (target === undefined) return { ok: false, message: 'Укажите этап возврата для всех выбранных деталей' };
    const targetStage = input.stageById.get(target);
    const current = detail.productionStatusId == null ? undefined : input.stageById.get(detail.productionStatusId);
    if (!targetStage || !isReworkTargetAllowed(targetStage, current, stages)) {
      return { ok: false, message: `Деталь №${detail.detailNumber ?? detail.id}: этап возврата должен быть раньше текущего и не «Выдан»` };
    }
    items.push({ detailId: detail.id, productionStatusId: target });
  }
  if (input.deadlineRequired && !input.plannedCompletionDate) return { ok: false, message: 'Укажите срок готовности' };
  const deadline = input.plannedCompletionDate ? { plannedCompletionDate: input.plannedCompletionDate } : {};
  if (!input.needsReason) return { ok: true, body: { ...deadline, details: items } };
  const reason = input.reasons.find((r) => r.reasonId === input.reasonId);
  if (!reason) return { ok: false, message: 'Выберите причину' };
  const comment = input.comment.trim();
  if (reason.requiresComment && !comment) return { ok: false, message: 'Для этой причины нужен комментарий' };
  return { ok: true, body: { reasonId: reason.reasonId, comment: comment || null, ...deadline, details: items } };
}

/**
 * The version a form may send (If-Match): only the one the rounds were read with, and only while
 * the card shows the same version — otherwise the data is stale or still loading (null → act later).
 */
export function reworkFormVersion(roundsVersion: number | null | undefined, cardVersion: number): number | null {
  return roundsVersion != null && roundsVersion === cardVersion ? roundsVersion : null;
}

/** Keeps only the latest response of overlapping loads. */
export function createLatestGate(): { begin: () => number; isLatest: (ticket: number) => boolean } {
  let current = 0;
  return { begin: () => ++current, isLatest: (ticket) => ticket === current };
}
