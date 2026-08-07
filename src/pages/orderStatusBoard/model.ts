import type {
  CncTelegramTodayColumn,
} from '../../api/types/cncTelegramApi.types';
import { cncBathDetailHasMachineFile } from './cncDetailedMachine';
import type {
  OrderStatusBoardCard,
  OrderStatusBoardColumn,
  OrderStatusBoardQuery,
  OrderStatusBoardResponse,
  OrderStatusBoardSortBy,
  OrderStatusBoardSortOrder,
  OrderStatusBoardType,
} from '../../api/types/orderStatusBoardApi.types';

const COMPLETED_ORDER_STATUS_NAMES = new Set(['завершен', 'завершён']);
export interface MdfBoardHiddenStatusesSetting {
  productionStatusIds: number[];
  orderStatusIds?: number[];
}

export const DEFAULT_MDF_BOARD_HIDDEN_PRODUCTION_STATUS_NAMES = [
  'закатан',
  'упакован',
  'выдан',
] as const;

const MDF_DEFAULT_HIDDEN_PRODUCTION_STATUS_NAMES = new Set(
  DEFAULT_MDF_BOARD_HIDDEN_PRODUCTION_STATUS_NAMES,
);
const DEFAULT_MDF_BOARD_HIDDEN_ORDER_STATUS_NAMES = [
  'выдан',
  'завершен',
  'завершён',
] as const;
const MDF_HIDDEN_ORDER_STATUS_NAMES = new Set(DEFAULT_MDF_BOARD_HIDDEN_ORDER_STATUS_NAMES);
export type OrderStatusBoardVisualFlow = OrderStatusBoardType | 'cnc_today';
export type CncOrderSearchPeriod = '1d' | '1w' | '2w' | '1m';
export type CncCardDisplayMode = 'standard' | 'compact';
export const DEFAULT_CNC_ORDER_SEARCH_PERIOD: CncOrderSearchPeriod = '1w';
const CNC_ORDER_SEARCH_PERIODS = new Set<CncOrderSearchPeriod>(['1d', '1w', '2w', '1m']);
export const DEFAULT_ORDER_STATUS_BOARD_SORT = {
  sortBy: 'priority',
  sortOrder: 'asc',
} as const;

export interface OrderStatusBoardSortPreference {
  sortBy: OrderStatusBoardSortBy;
  sortOrder: OrderStatusBoardSortOrder;
}

export interface OrderStatusBoardViewState {
  view: OrderStatusBoardVisualFlow;
  search: string;
  onlyMyOrders: boolean;
  overdueOnly: boolean;
  showDone: boolean;
  plannedFrom?: string;
  plannedTo?: string;
  cncWorkday?: string;
  cncOrderSearchPeriod?: CncOrderSearchPeriod;
  cncOrderFilters: string[];
  hideEmpty: boolean;
  sortBy: OrderStatusBoardSortBy;
  sortOrder: OrderStatusBoardSortOrder;
}

export interface OrderStatusBoardViewStateOptions {
  cncTelegram?: boolean;
  defaultSort?: OrderStatusBoardSortPreference;
}

export function toggleCncCardStandardOverride(
  current: ReadonlySet<string>,
  cardKey: string,
): Set<string> {
  const next = new Set(current);
  if (next.has(cardKey)) {
    next.delete(cardKey);
  } else {
    next.add(cardKey);
  }
  return next;
}

export function isCncCardSummaryOnly(
  displayMode: CncCardDisplayMode,
  standardOverrides: ReadonlySet<string>,
  cardKey: string,
  forceStandard = false,
): boolean {
  return !forceStandard && displayMode === 'compact' && !standardOverrides.has(cardKey);
}

export function filterBoardColumns(
  board: OrderStatusBoardType,
  columns: OrderStatusBoardColumn[],
  showDone = false,
): OrderStatusBoardColumn[] {
  if (board === 'production') {
    if (showDone) return columns;
    return columns.filter((column) => !isDoneProductionStatus(column));
  }
  return columns.filter(
    (column) =>
      !COMPLETED_ORDER_STATUS_NAMES.has(
        column.status.name.trim().toLocaleLowerCase('ru-RU'),
      ),
  );
}

export function parseOrderStatusBoardViewState(
  params: URLSearchParams,
  options: OrderStatusBoardViewStateOptions = {},
): OrderStatusBoardViewState {
  const board = params.get('board') === 'production' ? 'production' : 'order';
  const view = options.cncTelegram && params.get('flow') === 'cnc' ? 'cnc_today' : board;
  const plannedFrom = dateOnly(params.get('plannedFrom'));
  const plannedTo = dateOnly(params.get('plannedTo'));
  const cncWorkday = dateOnly(params.get('date'));
  const cncOrderSearchPeriod = view === 'cnc_today'
    ? parseCncOrderSearchPeriod(params.get('period')) ?? DEFAULT_CNC_ORDER_SEARCH_PERIOD
    : undefined;
  const sortByRaw = params.get('sort');
  const sortOrderRaw = params.get('direction');
  const sortBy = sortByRaw === null
    ? options.defaultSort?.sortBy ?? DEFAULT_ORDER_STATUS_BOARD_SORT.sortBy
    : parseOrderStatusBoardSortBy(sortByRaw) ?? DEFAULT_ORDER_STATUS_BOARD_SORT.sortBy;
  const sortOrder = sortOrderRaw === null
    ? options.defaultSort?.sortOrder ?? DEFAULT_ORDER_STATUS_BOARD_SORT.sortOrder
    : parseOrderStatusBoardSortOrder(sortOrderRaw) ?? DEFAULT_ORDER_STATUS_BOARD_SORT.sortOrder;
  return {
    view,
    search: params.get('q')?.trim() ?? '',
    onlyMyOrders: params.get('mine') === '1',
    overdueOnly: params.get('overdue') === '1',
    showDone: params.get('showDone') === '1',
    ...(plannedFrom ? { plannedFrom } : {}),
    ...(plannedTo ? { plannedTo } : {}),
    ...(cncWorkday ? { cncWorkday } : {}),
    ...(view === 'cnc_today' && cncOrderSearchPeriod ? { cncOrderSearchPeriod } : {}),
    cncOrderFilters: normalizeCncOrderFilterValues(params.getAll('order')),
    hideEmpty: params.get('hideEmpty') === '1',
    sortBy,
    sortOrder,
  };
}

export function serializeOrderStatusBoardViewState(
  state: OrderStatusBoardViewState,
): URLSearchParams {
  const params = new URLSearchParams();
  if (state.view === 'cnc_today') {
    params.set('flow', 'cnc');
  } else if (state.view !== 'order') {
    params.set('board', state.view);
  }
  if (state.search.trim()) params.set('q', state.search.trim());
  if (state.onlyMyOrders) params.set('mine', '1');
  if (state.overdueOnly) params.set('overdue', '1');
  if (state.showDone) params.set('showDone', '1');
  if (state.plannedFrom) params.set('plannedFrom', state.plannedFrom);
  if (state.plannedTo) params.set('plannedTo', state.plannedTo);
  if (state.view === 'cnc_today' && state.cncWorkday) params.set('date', state.cncWorkday);
  if (state.view === 'cnc_today' && state.cncOrderSearchPeriod) {
    params.set('period', state.cncOrderSearchPeriod);
  }
  if (state.view === 'cnc_today') {
    for (const orderName of normalizeCncOrderFilterValues(state.cncOrderFilters)) {
      params.append('order', orderName);
    }
  }
  if (state.hideEmpty) params.set('hideEmpty', '1');
  params.set('sort', state.sortBy);
  params.set('direction', state.sortOrder);
  return params;
}

export function toOrderStatusBoardQuery(
  state: OrderStatusBoardViewState,
  override: Partial<Pick<OrderStatusBoardQuery, 'column' | 'cursor'>> = {},
): OrderStatusBoardQuery {
  return {
    board: state.view === 'production' ? 'production' : 'order',
    limit: 24,
    ...(state.search.trim() ? { search: state.search.trim() } : {}),
    onlyMyOrders: state.onlyMyOrders,
    overdueOnly: state.overdueOnly,
    ...(state.view === 'production' && state.showDone
      ? { includeDone: true }
      : {}),
    ...(state.plannedFrom ? { plannedFrom: state.plannedFrom } : {}),
    ...(state.plannedTo ? { plannedTo: state.plannedTo } : {}),
    sortBy: state.sortBy,
    sortOrder: state.sortOrder,
    ...override,
  };
}

function parseOrderStatusBoardSortBy(value: string): OrderStatusBoardSortBy | undefined {
  if (
    value === 'priority'
    || value === 'orderNumber'
    || value === 'plannedDate'
    || value === 'updatedAt'
  ) {
    return value;
  }
  return undefined;
}

function parseOrderStatusBoardSortOrder(value: string): OrderStatusBoardSortOrder | undefined {
  return value === 'asc' || value === 'desc' ? value : undefined;
}

export function buildCncOrderFilterOptions(
  columns: CncTelegramTodayColumn[],
): string[] {
  const orderNamesByKey = new Map<string, string>();
  for (const column of columns) {
    for (const packet of column.packets ?? []) {
      for (const item of packet.items) {
        addCncOrderFilterOption(orderNamesByKey, item.orderName);
      }
    }
    for (const bath of column.baths ?? []) {
      for (const item of bath.items) {
        addCncOrderFilterOption(orderNamesByKey, item.orderName);
      }
    }
    for (const bazisCutSet of column.bazisCutSets ?? []) {
      for (const item of bazisCutSet.items) {
        addCncOrderFilterOption(orderNamesByKey, item.orderName);
      }
    }
  }
  return Array.from(orderNamesByKey.values()).sort(compareCncOrderNames);
}

export function filterCncTodayColumnsByOrders(
  columns: CncTelegramTodayColumn[],
  orderFilters: readonly string[],
): CncTelegramTodayColumn[] {
  const orderKeys = new Set(
    normalizeCncOrderFilterValues(orderFilters).map((value) =>
      normalizeCncOrderKey(value),
    ),
  );
  if (orderKeys.size === 0) return columns;

  return columns.map((column) => {
    const baths = (column.baths ?? []).filter((bath) =>
      bath.items.some((item) => orderKeys.has(normalizeCncOrderKey(item.orderName))),
    );
    const packets = (column.packets ?? []).filter((packet) =>
      packet.items.some((item) => orderKeys.has(normalizeCncOrderKey(item.orderName))),
    );
    const bazisCutSets = (column.bazisCutSets ?? []).filter((set) =>
      set.items.some((item) => orderKeys.has(normalizeCncOrderKey(item.orderName))),
    );
    const total = isCncBathColumnKey(column.key)
      ? baths.length
      : packets.length + bazisCutSets.length;
    return { ...column, baths, packets, bazisCutSets, total };
  });
}

export function filterCncBazisCutSetsByMissingBathDetails(
  columns: CncTelegramTodayColumn[],
): CncTelegramTodayColumn[] {
  const missingBathDetailIds = new Set<number>();
  for (const column of columns) {
    for (const bath of column.baths ?? []) {
      for (const item of bath.items) {
        if (!cncBathDetailHasMachineFile(columns, bath, item.detailId)) {
          missingBathDetailIds.add(item.detailId);
        }
      }
    }
  }

  return columns.map((column) => {
    const bazisCutSets = (column.bazisCutSets ?? []).filter((set) =>
      set.items.some((item) =>
        item.detailId !== null && missingBathDetailIds.has(item.detailId),
      ),
    );
    const total = column.key === 'parsed'
      ? (column.packets ?? []).length + bazisCutSets.length
      : column.total;
    return { ...column, bazisCutSets, total };
  });
}

export function filterCncBathColumnsByMachineOrderMatches(
  columns: CncTelegramTodayColumn[],
): CncTelegramTodayColumn[] {
  const machineOrderKeys = new Set<string>();
  for (const column of columns) {
    if (
      column.key !== 'parsed'
      && column.key !== 'completed'
      && column.key !== 'completed_laminated'
    ) continue;
    for (const packet of column.packets ?? []) {
      for (const item of packet.items) {
        const key = normalizeCncOrderKey(item.orderName);
        if (key) machineOrderKeys.add(key);
      }
    }
    for (const bazisCutSet of column.bazisCutSets ?? []) {
      for (const item of bazisCutSet.items) {
        const key = normalizeCncOrderKey(item.orderName);
        if (key) machineOrderKeys.add(key);
      }
    }
  }

  return columns.map((column) => {
    if (!isCncBathColumnKey(column.key)) return column;
    const baths = (column.baths ?? []).filter((bath) =>
      bath.items.some((item) => machineOrderKeys.has(normalizeCncOrderKey(item.orderName))),
    );
    return { ...column, baths, total: baths.length };
  });
}

export function isCncOrderHiddenFromMdfBoard(
  card: OrderStatusBoardCard,
  hiddenProductionStatusIds?: ReadonlySet<number>,
  hiddenOrderStatusIds?: ReadonlySet<number>,
): boolean {
  const productionStatusName = normalizeStatusName(card.productionStatusName);
  const orderStatusName = normalizeStatusName(card.orderStatusName);
  const hiddenByProductionStatus = hiddenProductionStatusIds
    ? isPositiveInteger(card.productionStatusId) && hiddenProductionStatusIds.has(card.productionStatusId)
    : MDF_DEFAULT_HIDDEN_PRODUCTION_STATUS_NAMES.has(productionStatusName);
  const hiddenByOrderStatus = hiddenOrderStatusIds
    ? isPositiveInteger(card.orderStatusId) && hiddenOrderStatusIds.has(card.orderStatusId)
    : card.orderStatusIssuedOrLater === true || MDF_HIDDEN_ORDER_STATUS_NAMES.has(orderStatusName);
  return (
    hiddenByProductionStatus
    || hiddenByOrderStatus
  );
}

export function resolveMdfBoardHiddenProductionStatusIds(
  columns: readonly OrderStatusBoardColumn[],
  setting: MdfBoardHiddenStatusesSetting | null | undefined,
): Set<number> {
  if (setting && Array.isArray(setting.productionStatusIds)) {
    return new Set(normalizePositiveIntegerArray(setting.productionStatusIds));
  }

  const ids = new Set<number>();
  for (const column of columns) {
    if (
      isPositiveInteger(column.status.id)
      && MDF_DEFAULT_HIDDEN_PRODUCTION_STATUS_NAMES.has(normalizeStatusName(column.status.name))
    ) {
      ids.add(column.status.id);
    }
  }
  return ids;
}

export function resolveMdfBoardHiddenOrderStatusIds(
  setting: MdfBoardHiddenStatusesSetting | null | undefined,
): Set<number> | undefined {
  if (!setting || !Array.isArray(setting.orderStatusIds)) return undefined;
  return new Set(normalizePositiveIntegerArray(setting.orderStatusIds));
}

export function resolveDefaultMdfBoardHiddenOrderStatusIds(
  statuses: readonly {
    id: number;
    name: string;
    sortOrder?: number | null;
  }[],
): number[] {
  const issuedSortOrders = statuses
    .filter((status) => normalizeStatusName(status.name) === 'выдан')
    .map((status) => status.sortOrder)
    .filter((sortOrder): sortOrder is number =>
      typeof sortOrder === 'number' && Number.isFinite(sortOrder));
  const issuedSortOrder = issuedSortOrders.length > 0 ? Math.min(...issuedSortOrders) : null;

  return normalizePositiveIntegerArray(
    statuses
      .filter((status) => {
        if (
          issuedSortOrder !== null
          && typeof status.sortOrder === 'number'
          && Number.isFinite(status.sortOrder)
        ) {
          return status.sortOrder >= issuedSortOrder;
        }
        return MDF_HIDDEN_ORDER_STATUS_NAMES.has(normalizeStatusName(status.name));
      })
      .map((status) => status.id),
  );
}

export function filterCncBathColumnsByOrderStatuses(
  columns: CncTelegramTodayColumn[],
  orderCards: readonly OrderStatusBoardCard[],
  hiddenProductionStatusIds?: ReadonlySet<number>,
  hiddenOrderStatusIds?: ReadonlySet<number>,
): CncTelegramTodayColumn[] {
  const hiddenOrderIds = new Set(
    orderCards
      .filter((card) => isCncOrderHiddenFromMdfBoard(
        card,
        hiddenProductionStatusIds,
        hiddenOrderStatusIds,
      ))
      .map((card) => card.orderId),
  );
  if (hiddenOrderIds.size === 0) return columns;

  return columns.map((column) => {
    if (column.key !== 'baths') return column;
    const baths = (column.baths ?? []).filter((bath) => {
      const orderIds = new Set(
        bath.items
          .map((item) => item.orderId)
          .filter((orderId) => Number.isInteger(orderId) && orderId > 0),
      );
      return orderIds.size === 0
        || Array.from(orderIds).some((orderId) => !hiddenOrderIds.has(orderId));
    });
    return { ...column, baths, total: baths.length };
  });
}

function isCncBathColumnKey(key: CncTelegramTodayColumn['key']): boolean {
  return key === 'baths' || key === 'baths_ready' || key === 'baths_laminated';
}

export function collectCncOrderIds(columns: CncTelegramTodayColumn[]): number[] {
  const orderIds = new Set<number>();
  for (const column of columns) {
    for (const packet of column.packets ?? []) {
      for (const item of packet.items) {
        addCncOrderId(orderIds, item.orderId ?? item.matchOrderId);
      }
    }
    for (const bath of column.baths ?? []) {
      for (const item of bath.items) {
        addCncOrderId(orderIds, item.orderId);
      }
    }
    for (const bazisCutSet of column.bazisCutSets ?? []) {
      for (const item of bazisCutSet.items) {
        addCncOrderId(orderIds, item.orderId);
      }
    }
  }
  return Array.from(orderIds).sort((left, right) => left - right);
}

export function buildCncOrderSearchDateRange(
  workday: string,
  period: CncOrderSearchPeriod | undefined,
): { dateFrom: string; dateTo: string; days: number } {
  const days = cncOrderSearchPeriodDays(period);
  return {
    dateFrom: subtractDateOnlyDays(workday, days - 1),
    dateTo: workday,
    days,
  };
}

export function cncOrderSearchPeriodDays(
  period: CncOrderSearchPeriod | undefined,
): number {
  if (period === '1d') return 1;
  if (period === '1w') return 7;
  if (period === '2w') return 14;
  if (period === '1m') return 31;
  return 7;
}

function addCncOrderId(target: Set<number>, value: number | null | undefined): void {
  if (Number.isInteger(value) && Number(value) > 0) {
    target.add(Number(value));
  }
}

function isDoneProductionStatus(column: OrderStatusBoardColumn): boolean {
  const name = column.status.name.trim().toLocaleLowerCase('en-US');
  const code = column.status.code?.trim().toLocaleLowerCase('en-US') ?? '';
  return (
    name === 'done'
    || name === 'завершено'
    || /^(?:done|zaversheno)(?:_|$)/.test(code)
  );
}

export type MergeColumnPageResult =
  | { kind: 'applied'; board: OrderStatusBoardResponse }
  | { kind: 'discarded'; board: OrderStatusBoardResponse }
  | { kind: 'anomaly'; board: OrderStatusBoardResponse };

export function mergeOrderStatusBoardColumnPage(
  current: OrderStatusBoardResponse,
  incoming: OrderStatusBoardResponse,
  expectedFilterKey: string,
): MergeColumnPageResult {
  if (
    current.board !== incoming.board ||
    current.filterKey !== expectedFilterKey ||
    incoming.filterKey !== expectedFilterKey
  ) {
    return { kind: 'discarded', board: current };
  }
  if (incoming.columns.length !== 1) {
    return { kind: 'anomaly', board: current };
  }

  const page = incoming.columns[0]!;
  const target = current.columns.find((column) => column.key === page.key);
  if (!target) {
    return { kind: 'anomaly', board: current };
  }

  const incomingIds = new Set(page.cards.map((card) => card.orderId));
  const columns = current.columns.map((column) => {
    if (column.key !== page.key) {
      return {
        ...column,
        cards: column.cards.filter((card) => !incomingIds.has(card.orderId)),
      };
    }

    const cards = new Map(column.cards.map((card) => [card.orderId, card]));
    for (const card of page.cards) cards.set(card.orderId, card);
    const mergedCards = Array.from(cards.values());
    if (page.total < mergedCards.length) {
      return null;
    }
    return {
      ...column,
      status: page.status,
      total: page.total,
      cards: mergedCards,
      nextCursor: page.nextCursor,
    };
  });

  if (columns.some((column) => column === null)) {
    return { kind: 'anomaly', board: current };
  }

  const seen = new Set<number>();
  for (const column of columns) {
    for (const card of column!.cards) {
      if (seen.has(card.orderId)) {
        return { kind: 'anomaly', board: current };
      }
      seen.add(card.orderId);
    }
  }

  return {
    kind: 'applied',
    board: {
      ...current,
      generatedAt: incoming.generatedAt,
      columns: columns as OrderStatusBoardResponse['columns'],
    },
  };
}

function dateOnly(value: string | null): string | undefined {
  if (
    !value ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    value.startsWith('0000-')
  ) {
    return undefined;
  }
  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString().slice(0, 10) === value
    ? value
    : undefined;
}

function parseCncOrderSearchPeriod(value: string | null): CncOrderSearchPeriod | undefined {
  return value && CNC_ORDER_SEARCH_PERIODS.has(value)
    ? value as CncOrderSearchPeriod
    : undefined;
}

function subtractDateOnlyDays(value: string, days: number): string {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function normalizeCncOrderKey(value: string | null | undefined): string {
  return (value ?? '').trim().toLocaleLowerCase('ru-RU');
}

function normalizeStatusName(value: string | null | undefined): string {
  return (value ?? '').trim().toLocaleLowerCase('ru-RU');
}

function normalizePositiveIntegerArray(value: readonly unknown[]): number[] {
  const ids = new Set<number>();
  for (const item of value) {
    const numeric = typeof item === 'number' ? item : Number(item);
    if (Number.isInteger(numeric) && numeric > 0) ids.add(numeric);
  }
  return Array.from(ids).sort((left, right) => left - right);
}

function isPositiveInteger(value: number | null | undefined): value is number {
  return Number.isInteger(value) && Number(value) > 0;
}

function normalizeCncOrderFilterValues(values: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const rawValue of values) {
    for (const part of rawValue.split(',')) {
      const value = part.trim();
      const key = normalizeCncOrderKey(value);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      result.push(value);
    }
  }
  return result;
}

function addCncOrderFilterOption(
  orderNamesByKey: Map<string, string>,
  value: string | null | undefined,
) {
  const orderName = (value ?? '').trim();
  const orderKey = normalizeCncOrderKey(orderName);
  if (!orderKey || orderNamesByKey.has(orderKey)) return;
  orderNamesByKey.set(orderKey, orderName);
}

function compareCncOrderNames(a: string, b: string): number {
  return a.localeCompare(b, 'ru-RU', {
    numeric: true,
    sensitivity: 'base',
  });
}
