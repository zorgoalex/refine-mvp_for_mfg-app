import type { Dayjs } from 'dayjs';
import type {
  CncSawnApplyConfirmItem,
  CncSawnApplyPreviewItem,
  CncSawnApplyResultKind,
  CncSawnApplyState,
  CncSawnBlockedReason,
  CncSawnMessageRole,
  CncSawnSignalOrigin,
  CncSawnSignalReactor,
  CncSawnSignalsQuery,
} from '../../api/types/cncSawnSignals.types';

export const SAWN_APPLY_STATE_LABELS: Record<CncSawnApplyState, string> = {
  pending: 'Ожидает переноса',
  held_disabled: 'Не перенесён: перенос выключен',
  held_baseline: 'Не перенесён: 👍 был до запуска',
  held_history: 'Не перенесён: пакет возвращали вручную',
  held_return_barrier: 'Не перенесён: пакет возвращён в работу',
  held_engine: 'Не перенесён: пакеты ведёт движок',
  retry_wait: 'Повтор позже',
  failed_final: 'Ошибка переноса',
  applied: 'Перенесён',
  already_completed: 'Уже завершён',
  closed: 'Закрыт (👍 снят)',
};

export const SAWN_APPLY_STATE_COLORS: Record<CncSawnApplyState, string> = {
  pending: 'processing',
  held_disabled: 'default',
  held_baseline: 'default',
  held_history: 'gold',
  held_return_barrier: 'orange',
  held_engine: 'default',
  retry_wait: 'gold',
  failed_final: 'red',
  applied: 'green',
  already_completed: 'green',
  closed: 'default',
};

export const SAWN_BLOCKED_REASON_LABELS: Record<CncSawnBlockedReason, string> = {
  stale_observation: 'Сигнал устарел: ERP давно не видела 👍',
  closed: '👍 уже снят',
  return_barrier: 'Пакет возвращён в работу',
  engine_mode: 'Пакеты ведёт движок',
  already_completed: 'Пакет уже завершён',
  already_applied: 'Сигнал уже применён',
  read_only: 'Учёт переключается, повторите позже',
};

export const SAWN_APPLY_RESULT_LABELS: Record<CncSawnApplyResultKind, string> = {
  applied: 'Применено',
  stale_conflict: 'Устарело — обновите предпросмотр',
  blocked: 'Заблокировано',
  retry_later: 'Повторите позже',
};

export const SAWN_APPLY_RESULT_COLORS: Record<CncSawnApplyResultKind, string> = {
  applied: 'green',
  stale_conflict: 'gold',
  blocked: 'red',
  retry_later: 'orange',
};

export const SAWN_ROLE_LABELS: Record<CncSawnMessageRole, string> = {
  file: 'файл',
  comment: 'комментарий',
  unknown: 'неизвестно',
};

export const SAWN_ORIGIN_LABELS: Record<CncSawnSignalOrigin, string> = {
  live: 'новый',
  baseline: 'до запуска',
};

export const SAWN_APPLY_STATE_OPTIONS = (Object.keys(SAWN_APPLY_STATE_LABELS) as CncSawnApplyState[])
  .map((value) => ({ value, label: SAWN_APPLY_STATE_LABELS[value] }));

export interface SawnFilterValues {
  period?: [Dayjs, Dayjs] | null;
  cuttingSequenceNo?: number | string | null;
  applyState?: CncSawnApplyState | null;
  openOnly?: boolean;
}

export function buildSawnSignalsQuery(values: SawnFilterValues, page = 1, pageSize = 50): CncSawnSignalsQuery {
  const seq = values.cuttingSequenceNo === null || values.cuttingSequenceNo === undefined || values.cuttingSequenceNo === ''
    ? NaN
    : Number(values.cuttingSequenceNo);
  return {
    from: values.period?.[0]?.startOf('day').toISOString(),
    to: values.period?.[1]?.endOf('day').toISOString(),
    cuttingSequenceNo: Number.isSafeInteger(seq) && seq > 0 ? seq : undefined,
    applyState: values.applyState || undefined,
    openOnly: values.openOnly ? true : undefined,
    page,
    pageSize,
  };
}

export function sawnReactorText(reactor: CncSawnSignalReactor | null): string {
  if (!reactor) return 'скрыто Telegram';
  const name = reactor.displayName?.trim();
  const username = reactor.username?.trim();
  if (name && username) return `${name} (@${username})`;
  if (name) return name;
  if (username) return `@${username}`;
  return `${reactor.peerType} #${reactor.peerId}`;
}

export function sawnEligibleIds(items: readonly CncSawnApplyPreviewItem[]): number[] {
  return items.filter((item) => item.eligible).map((item) => item.packetSignalId);
}

/** Confirm payload: only eligible previewed items that are still checked, with their digests. */
export function buildSawnConfirmItems(
  items: readonly CncSawnApplyPreviewItem[],
  selectedIds: readonly number[],
): CncSawnApplyConfirmItem[] {
  const selected = new Set(selectedIds);
  return items
    .filter((item) => item.eligible && selected.has(item.packetSignalId))
    .map((item) => ({ packetSignalId: item.packetSignalId, effectDigest: item.effectDigest }));
}
