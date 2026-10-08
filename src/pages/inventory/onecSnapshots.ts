import type { OnecSnapshotDto, OnecSnapshotItemDto, OnecSnapshotsPage, OnecSnapshotStatus } from '../../api/types/inventoryApi.types';

// Срезы остатков 1С на дату: подписи и чистые помощники экрана (backend — /inventory/onec-snapshots).

export const SNAPSHOT_STATUS_LABEL: Record<OnecSnapshotStatus, string> = {
  requested: 'В очереди', config_published: 'Отправлен агенту', syncing: 'Читается из 1С', ready: 'Готов', failed: 'Ошибка',
};
export const SNAPSHOT_STATUS_COLOR: Record<OnecSnapshotStatus, string> = {
  requested: 'default', config_published: 'processing', syncing: 'processing', ready: 'success', failed: 'error',
};

/** Почему срез ждёт в очереди (не ошибка). Неизвестный код показывается как есть. */
const WAIT_REASON: Record<string, string> = {
  AGENT_OFFLINE: 'агент 1С не на связи', QUIET_WINDOW: 'тихое окно агента', SYNC_WINDOW: 'идёт плановая выгрузка 1С',
  AGENT_TOO_OLD: 'агент 1С старее 1.3.11', ANOTHER_ACTIVE: 'читается другой срез',
};
const ERROR_CODE: Record<string, string> = {
  CANCELLED: 'запрос отменён', TOO_MANY_ROWS: 'слишком много строк в срезе', SOURCE_GENERATION_CHANGED: 'база 1С заменена во время чтения',
  TIMEOUT: 'истёк срок ожидания ответа 1С', ONEC_REJECTED: '1С отклонила запрос', AGENT_REJECTED: 'агент отклонил запрос',
};
/** Почему нельзя запросить новый срез. */
const CAPABILITY_REASON: Record<string, string> = {
  MODULE_DISABLED: 'срезы выключены на сервере', SOURCE_NOT_CONFIGURED: 'источник 1С не настроен', AGENT_TOO_OLD: 'агент 1С старее 1.3.11',
};
export const snapshotWaitReason = (code: string | null): string | null => (code === null ? null : WAIT_REASON[code] ?? code);
export const snapshotError = (code: string | null): string | null => (code === null ? null : ERROR_CODE[code] ?? code);
export const snapshotCapabilityReason = (code: string | null): string => (code === null ? 'запрос новых срезов недоступен' : CAPABILITY_REASON[code] ?? code);

export const isSnapshotActive = (snapshot: Pick<OnecSnapshotDto, 'status'>): boolean =>
  snapshot.status === 'requested' || snapshot.status === 'config_published' || snapshot.status === 'syncing';

/** Пояснение к статусу: место в очереди, причина ожидания или ошибки. */
export function snapshotStatusDetail(snapshot: Pick<OnecSnapshotDto, 'status' | 'waitReason' | 'errorCode' | 'queuePosition'>): string | null {
  if (snapshot.status === 'failed') return snapshotError(snapshot.errorCode);
  if (snapshot.status !== 'requested') return null;
  const wait = snapshotWaitReason(snapshot.waitReason);
  const place = snapshot.queuePosition !== null && snapshot.queuePosition > 1 ? `${snapshot.queuePosition}-й в очереди` : null;
  return [place, wait].filter(Boolean).join(', ') || null;
}

/** `2026-09-26T10:14:00` → `26.09.2026 10:14` (секунды — только ненулевые). Местное время базы 1С, без пересчёта пояса. */
export function formatSnapshotMoment(momentLocal: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(momentLocal);
  if (!match) return momentLocal;
  const [, year, month, day, hour, minute, second] = match;
  return `${day}.${month}.${year} ${hour}:${minute}${second === '00' ? '' : `:${second}`}`;
}

/** Значение поля выбора даты и времени (то, что видит пользователь) → момент для запроса; секунды — 00. */
export function toSnapshotMoment(value: { format(pattern: string): string } | null | undefined): string | null {
  return value ? value.format('YYYY-MM-DDTHH:mm:00') : null;
}

export const snapshotLabel = (snapshot: Pick<OnecSnapshotDto, 'id' | 'momentLocal'>): string => `№ ${snapshot.id} на ${formatSnapshotMoment(snapshot.momentLocal)}`;

/**
 * Что показывать на экране: `hidden` — прежний backend (404) или срезы не подключены; `readonly` — история без
 * запроса новых (с причиной); `full` — всё. Ошибка не про поддержку (сеть, 500) — как `hidden`, без шума.
 */
export function snapshotsMode(page: OnecSnapshotsPage | undefined, failed: boolean): 'hidden' | 'readonly' | 'full' {
  if (failed || !page || !page.readAvailable) return 'hidden';
  return page.commandsAvailable ? 'full' : 'readonly';
}

export function snapshotExportRows(items: readonly OnecSnapshotItemDto[], compared: boolean): Array<Record<string, string | number>> {
  return items.map((item) => ({
    Вкладка: item.groupLabel,
    Наименование: item.name,
    'Код 1С': item.code ?? '',
    'Категория 1С': item.categoryName ?? '',
    'В срезе': item.quantity,
    ...(compared ? { 'Вторая сторона': item.otherQuantity ?? 0, Разница: item.delta ?? 0 } : {}),
    'Ед.': item.unitName ?? '',
  }));
}

/** Тон разницы: рост — плюс, убыль — минус, без изменений — ноль. */
export const deltaTone = (delta: number | null): 'plus' | 'minus' | 'zero' => (delta === null || delta === 0 ? 'zero' : delta > 0 ? 'plus' : 'minus');
export const formatDelta = (delta: number | null): string =>
  delta === null ? '—' : `${delta > 0 ? '+' : ''}${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 3 }).format(delta)}`;

/**
 * Ключ идемпотентности запроса среза закреплён за намерением `{момент, заново}`: повтор после потерянного ответа
 * уходит с тем же ключом (сервер вернёт тот же срез, а не создаст второй). Новое намерение или подтверждённый
 * успех (`null`) — новый ключ.
 */
export interface SnapshotRequestIntent { momentLocal: string; force: boolean; key: string }
export function requestIntent(previous: SnapshotRequestIntent | null, momentLocal: string, force: boolean, newKey: () => string): SnapshotRequestIntent {
  return previous && previous.momentLocal === momentLocal && previous.force === force ? previous : { momentLocal, force, key: newKey() };
}

/**
 * Выгрузка читает всё представление ОДНИМ запросом (сервер отдаёт его из одного снимка данных): постраничная
 * догрузка смешала бы разные версии остатков, названий и связей и дала бы пропуски и дубли строк.
 */
export const SNAPSHOT_EXPORT_LIMIT = 40_000;
/** Все строки представления получены одной страницей. */
export const exportComplete = (page: { total: number; items: readonly unknown[] }): boolean => page.items.length === page.total;

/**
 * Что делать с ошибкой чтения в просмотре среза: `close` — открытого среза больше нет (удалён); `drop-compare` —
 * пропала вторая сторона сравнения (другой срез удалён или стал несравним); `show` — показать ошибку.
 */
export function viewFailureAction(
  source: 'card' | 'stock', error: { code?: string; statusCode?: number; status?: number } | null | undefined, comparingWithSnapshot: boolean,
): 'close' | 'drop-compare' | 'show' {
  const notFound = error?.code === 'ONEC_STOCK_SNAPSHOT_NOT_FOUND';
  if (source === 'card') return notFound ? 'close' : 'show';
  if (notFound) return comparingWithSnapshot ? 'drop-compare' : 'close';
  return comparingWithSnapshot && (error?.code === 'ONEC_SNAPSHOT_SOURCE_MISMATCH' || error?.code === 'ONEC_STOCK_SNAPSHOT_NOT_READY') ? 'drop-compare' : 'show';
}

/**
 * Пояснение о составе складов. Просмотр и сравнение срезов без выбора — все склады среза, включая склады 1С без пары
 * в ERP. Сравнение с текущими остатками идёт только по складам ERP: склады 1С без пары в него не входят.
 */
export function warehouseScopeNote(input: {
  compareWith: 'current' | number | undefined; selectedCount: number;
  compared: ReadonlyArray<{ name: string }> | undefined; outside: ReadonlyArray<string>;
}): string | null {
  if (input.compareWith === 'current') {
    const compared = input.compared && input.compared.length > 0 ? `Сравниваются склады ERP: ${input.compared.map((row) => row.name).join(', ')}.` : null;
    const excluded = input.outside.length > 0 ? `Склады 1С, не заведённые в ERP, в сравнение с текущими остатками не входят: ${input.outside.join(', ')}.` : null;
    return [compared, excluded].filter(Boolean).join(' ') || null;
  }
  if (input.selectedCount === 0 && input.outside.length > 0) {
    return `В срезе есть склады 1С, не заведённые в ERP: ${input.outside.join(', ')}. Без выбора складов они входят в итог.`;
  }
  return null;
}
export const warehousePlaceholder = (compareWith: 'current' | number | undefined): string =>
  compareWith === 'current' ? 'Все склады ERP, связанные с 1С' : 'Все склады среза';
