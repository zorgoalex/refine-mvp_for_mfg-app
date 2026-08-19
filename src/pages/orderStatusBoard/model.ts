import type {
  CncTelegramBathCard,
  CncTelegramBazisCutSetCard,
  CncTelegramPacket,
  CncTelegramTodayColumn,
} from '../../api/types/cncTelegramApi.types';
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
  productionStatusIds?: number[];
  orderStatusIds?: number[];
  cardRules?: MdfBoardHiddenCardRule[];
}

export type MdfBoardHiddenCardKind = 'packet' | 'bazisCutSet' | 'bath';

export interface MdfBoardHiddenCardRule {
  cardKind: MdfBoardHiddenCardKind;
  orderStatusIds: number[];
}

export const MDF_BOARD_HIDDEN_CARD_KINDS: readonly MdfBoardHiddenCardKind[] = [
  'packet',
  'bazisCutSet',
  'bath',
] as const;

const MDF_BOARD_HIDDEN_COLUMN_TITLES: Partial<
  Record<CncTelegramTodayColumn['key'], string>
> = {
  completed_laminated: 'Распиленные файлы',
  baths_laminated: 'Завершённые ванны',
};

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
export type CncCardDisplayMode = 'standard' | 'compact' | 'minimal' | 'screenshot';
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

export const DEFAULT_MDF_ORDER_CARD_SORT: OrderStatusBoardSortPreference = {
  sortBy: 'orderNumber',
  sortOrder: 'asc',
};

export interface CncOrderMissingDetail {
  detailId: number;
  detailNumber: number | null;
  requiredQuantity: number;
  presentQuantity: number;
  missingQuantity: number;
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
  cncPlannedTodayOnly: boolean;
  cncCardKind?: 'packet' | 'bath';
  cncCardId?: string;
  hideEmpty: boolean;
  sortBy: OrderStatusBoardSortBy;
  sortOrder: OrderStatusBoardSortOrder;
}

export interface OrderStatusBoardViewStateOptions {
  cncTelegram?: boolean;
  defaultCncOrderSearchPeriod?: CncOrderSearchPeriod;
  defaultSort?: OrderStatusBoardSortPreference;
  fixedView?: OrderStatusBoardVisualFlow;
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
  if (forceStandard) return false;
  if (displayMode === 'minimal') return true;
  return displayMode === 'compact' && !standardOverrides.has(cardKey);
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
  const routeView = options.cncTelegram && params.get('flow') === 'cnc' ? 'cnc_today' : board;
  const view = options.fixedView ?? routeView;
  const plannedFrom = dateOnly(params.get('plannedFrom'));
  const plannedTo = dateOnly(params.get('plannedTo'));
  const cncWorkday = dateOnly(params.get('date'));
  const defaultCncOrderSearchPeriod =
    options.defaultCncOrderSearchPeriod ?? DEFAULT_CNC_ORDER_SEARCH_PERIOD;
  const cncOrderSearchPeriod = view === 'cnc_today'
    ? parseCncOrderSearchPeriod(params.get('period')) ?? defaultCncOrderSearchPeriod
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
    cncPlannedTodayOnly: view === 'cnc_today' && params.get('plannedToday') === '1',
    ...(view === 'cnc_today' && (params.get('cardKind') === 'packet' || params.get('cardKind') === 'bath')
      && params.get('cardId')?.trim()
      ? {
          cncCardKind: params.get('cardKind') as 'packet' | 'bath',
          cncCardId: params.get('cardId')!.trim(),
        }
      : {}),
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
  if (state.view === 'cnc_today' && state.cncCardKind && state.cncCardId) {
    params.set('cardKind', state.cncCardKind);
    params.set('cardId', state.cncCardId);
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
  if (state.view === 'cnc_today' && state.cncPlannedTodayOnly) {
    params.set('plannedToday', '1');
  }
  if (state.hideEmpty) params.set('hideEmpty', '1');
  params.set('sort', state.sortBy);
  params.set('direction', state.sortOrder);
  return params;
}

export function buildOrderStatusBoardDatasetKey(
  params: URLSearchParams,
  state: Pick<
    OrderStatusBoardViewState,
    'view' | 'cncWorkday' | 'cncOrderSearchPeriod'
  >,
  defaultCncWorkday: string,
  defaultCncOrderSearchPeriod: CncOrderSearchPeriod = DEFAULT_CNC_ORDER_SEARCH_PERIOD,
): string {
  if (state.view === 'cnc_today') {
    const key = new URLSearchParams();
    key.set('flow', 'cnc');
    key.set('date', state.cncWorkday ?? defaultCncWorkday);
    key.set('period', state.cncOrderSearchPeriod ?? defaultCncOrderSearchPeriod);
    return key.toString();
  }
  return params.toString();
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

export function filterCncOrderCardsByPlannedOrderDate(
  cards: readonly OrderStatusBoardCard[],
  plannedDate: string,
): OrderStatusBoardCard[] {
  const plannedDateOnly = dateOnlyPrefix(plannedDate);
  if (!plannedDateOnly) return [...cards];
  return cards.filter((card) =>
    dateOnlyPrefix(card.plannedCompletionDate) === plannedDateOnly);
}

export function filterCncTodayColumnsByPlannedOrderDate(
  columns: CncTelegramTodayColumn[],
  orderCards: readonly OrderStatusBoardCard[],
  plannedDate: string,
): CncTelegramTodayColumn[] {
  const plannedDateOnly = dateOnlyPrefix(plannedDate);
  if (!plannedDateOnly) return columns;
  const matcher = buildCncPlannedOrderMatcher(orderCards, plannedDateOnly);

  return columns.map((column) => {
    const baths = (column.baths ?? []).filter((bath) =>
      bath.items.some((item) =>
        cncItemMatchesPlannedOrder(matcher, item.orderName, item.orderId)),
    );
    const packets = (column.packets ?? []).filter((packet) =>
      packet.items.some((item) =>
        cncItemMatchesPlannedOrder(
          matcher,
          item.orderName,
          item.orderId,
          item.matchOrderId,
        )),
    );
    const bazisCutSets = (column.bazisCutSets ?? []).filter((set) =>
      set.items.some((item) =>
        cncItemMatchesPlannedOrder(matcher, item.orderName, item.orderId)),
    );
    const total = isCncBathColumnKey(column.key)
      ? baths.length
      : packets.length + bazisCutSets.length;
    return { ...column, baths, packets, bazisCutSets, total };
  });
}

export function filterCncBathColumnsByMachineOrderMatches(
  columns: CncTelegramTodayColumn[],
  preservedBathCardId?: string,
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
      bath.bathCardId === preservedBathCardId
      || bath.items.some((item) => machineOrderKeys.has(normalizeCncOrderKey(item.orderName))),
    );
    return { ...column, baths, total: baths.length };
  });
}

export function buildCncOrderMissingDetails(
  cards: readonly OrderStatusBoardCard[],
  columns: readonly CncTelegramTodayColumn[],
): Map<number, CncOrderMissingDetail[]> {
  const orderIdByOrderKey = new Map<string, number>();
  for (const card of cards) {
    const orderKey = normalizeCncOrderKey(card.orderName);
    if (orderKey && !orderIdByOrderKey.has(orderKey)) {
      orderIdByOrderKey.set(orderKey, card.orderId);
    }
  }

  const quantityByDetailId = new Map<number, Map<number, number>>();
  const quantityByDetailNumber = new Map<number, Map<number, number>>();
  const addPresentQuantity = (
    orderId: number | null | undefined,
    orderName: string | null | undefined,
    detailId: number | null | undefined,
    detailNumber: number | null | undefined,
    quantity: number,
  ) => {
    const resolvedOrderId = resolveCncOrderId(orderId, orderName, orderIdByOrderKey);
    if (resolvedOrderId === null) return;
    const safeQuantity = nonNegativeInteger(quantity);
    if (safeQuantity <= 0) return;
    const safeDetailId = positiveIntegerOrNull(detailId);
    if (safeDetailId !== null) {
      addNestedQuantity(quantityByDetailId, resolvedOrderId, safeDetailId, safeQuantity);
      return;
    }
    const safeDetailNumber = positiveIntegerOrNull(detailNumber);
    if (safeDetailNumber !== null) {
      addNestedQuantity(quantityByDetailNumber, resolvedOrderId, safeDetailNumber, safeQuantity);
    }
  };

  for (const column of columns) {
    for (const packet of column.packets ?? []) {
      for (const item of packet.items) {
        addPresentQuantity(
          item.matchOrderId ?? item.orderId,
          item.orderName,
          item.matchDetailId,
          item.detailNumber,
          item.quantity,
        );
      }
    }
    for (const bazisCutSet of column.bazisCutSets ?? []) {
      for (const item of bazisCutSet.items) {
        addPresentQuantity(
          item.orderId,
          item.orderName,
          item.detailId,
          item.detailNumber,
          item.quantity,
        );
      }
    }
  }

  const result = new Map<number, CncOrderMissingDetail[]>();
  for (const card of cards) {
    const detailIdQuantities = quantityByDetailId.get(card.orderId);
    const detailNumberQuantities = quantityByDetailNumber.get(card.orderId);
    const missing = (card.details ?? []).flatMap((detail): CncOrderMissingDetail[] => {
      const requiredQuantity = nonNegativeInteger(detail.quantity);
      if (requiredQuantity <= 0) return [];
      const byDetailId = detailIdQuantities?.get(detail.detailId) ?? 0;
      const byDetailNumber = detail.detailNumber === null
        ? 0
        : detailNumberQuantities?.get(detail.detailNumber) ?? 0;
      const byBazisCut = nonNegativeInteger(detail.bazisCutQuantity);
      const presentQuantity = Math.min(
        requiredQuantity,
        Math.max(byDetailId, byDetailNumber, byBazisCut),
      );
      const missingQuantity = requiredQuantity - presentQuantity;
      if (missingQuantity <= 0) return [];
      return [{
        detailId: detail.detailId,
        detailNumber: detail.detailNumber,
        requiredQuantity,
        presentQuantity,
        missingQuantity,
      }];
    }).sort(compareCncMissingDetails);

    if (missing.length > 0) result.set(card.orderId, missing);
  }
  return result;
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

export function normalizeMdfBoardHiddenCardRules(
  setting: MdfBoardHiddenStatusesSetting | null | undefined,
  fallbackOrderStatusIds: readonly unknown[] = [],
): MdfBoardHiddenCardRule[] {
  const rules = Array.isArray(setting?.cardRules) ? setting.cardRules : [];
  const fallback = normalizePositiveIntegerArray(fallbackOrderStatusIds);
  return MDF_BOARD_HIDDEN_CARD_KINDS.map((cardKind) => {
    const rule = rules.find((candidate) => candidate?.cardKind === cardKind);
    return {
      cardKind,
      orderStatusIds: normalizePositiveIntegerArray(rule?.orderStatusIds ?? fallback),
    };
  });
}

export function applyMdfBoardHiddenCardRulesToColumns(
  columns: CncTelegramTodayColumn[],
  orderCards: readonly OrderStatusBoardCard[],
  setting: MdfBoardHiddenStatusesSetting | null | undefined,
  legacyHiddenProductionStatusIds?: ReadonlySet<number>,
  legacyHiddenOrderStatusIds?: ReadonlySet<number>,
): CncTelegramTodayColumn[] {
  if (!Array.isArray(setting?.cardRules)) {
    return filterCncBathColumnsByOrderStatuses(
      columns,
      orderCards,
      legacyHiddenProductionStatusIds,
      legacyHiddenOrderStatusIds,
    );
  }

  const rulesByKind = new Map(
    normalizeMdfBoardHiddenCardRules(setting).map((rule) => [
      rule.cardKind,
      new Set(rule.orderStatusIds),
    ]),
  );
  const orderStatusIdByOrderId = new Map(
    orderCards
      .filter((card) => isPositiveInteger(card.orderId) && isPositiveInteger(card.orderStatusId))
      .map((card) => [card.orderId, card.orderStatusId] as const),
  );

  const byKey = new Map<CncTelegramTodayColumn['key'], CncTelegramTodayColumn>();
  const ensureColumn = (key: CncTelegramTodayColumn['key']): CncTelegramTodayColumn => {
    const existing = byKey.get(key);
    if (existing) return existing;
    const source = columns.find((column) => column.key === key);
    const next: CncTelegramTodayColumn = {
      key,
      title: source?.title ?? MDF_BOARD_HIDDEN_COLUMN_TITLES[key] ?? key,
      total: 0,
      packets: [],
      baths: [],
      bazisCutSets: [],
    };
    byKey.set(key, next);
    return next;
  };

  for (const column of columns) {
    ensureColumn(column.key);
  }

  for (const column of columns) {
    for (const packet of column.packets) {
      const target = mdfBoardHiddenCardRuleMatches(
        'packet',
        collectPacketOrderIds(packet),
        rulesByKind,
        orderStatusIdByOrderId,
      )
        ? 'completed_laminated'
        : column.key;
      ensureColumn(target).packets.push(packet);
    }

    for (const bazisCutSet of column.bazisCutSets ?? []) {
      const target = mdfBoardHiddenCardRuleMatches(
        'bazisCutSet',
        collectBazisCutSetOrderIds(bazisCutSet),
        rulesByKind,
        orderStatusIdByOrderId,
      )
        ? 'completed_laminated'
        : column.key;
      ensureColumn(target).bazisCutSets?.push(bazisCutSet);
    }

    for (const bath of column.baths) {
      const target = mdfBoardHiddenCardRuleMatches(
        'bath',
        collectBathOrderIds(bath),
        rulesByKind,
        orderStatusIdByOrderId,
      )
        ? 'baths_laminated'
        : column.key;
      ensureColumn(target).baths.push(bath);
    }
  }

  return Array.from(byKey.values()).map((column) => {
    const baths = column.baths ?? [];
    const packets = column.packets ?? [];
    const bazisCutSets = column.bazisCutSets ?? [];
    return {
      ...column,
      packets,
      baths,
      bazisCutSets,
      total: isCncBathColumnKey(column.key)
        ? baths.length
        : packets.length + bazisCutSets.length,
    };
  });
}

function mdfBoardHiddenCardRuleMatches(
  cardKind: MdfBoardHiddenCardKind,
  orderIds: readonly number[],
  rulesByKind: ReadonlyMap<MdfBoardHiddenCardKind, ReadonlySet<number>>,
  orderStatusIdByOrderId: ReadonlyMap<number, number>,
): boolean {
  const allowedStatusIds = rulesByKind.get(cardKind);
  if (!allowedStatusIds || allowedStatusIds.size === 0 || orderIds.length === 0) return false;
  return orderIds.every((orderId) => {
    const orderStatusId = orderStatusIdByOrderId.get(orderId);
    return isPositiveInteger(orderStatusId) && allowedStatusIds.has(orderStatusId);
  });
}

function collectPacketOrderIds(packet: CncTelegramPacket): number[] {
  return normalizePositiveIntegerArray(
    packet.items.map((item) => item.matchOrderId ?? item.orderId),
  );
}

function collectBazisCutSetOrderIds(bazisCutSet: CncTelegramBazisCutSetCard): number[] {
  return normalizePositiveIntegerArray(bazisCutSet.items.map((item) => item.orderId));
}

function collectBathOrderIds(bath: CncTelegramBathCard): number[] {
  return normalizePositiveIntegerArray(bath.items.map((item) => item.orderId));
}

function isCncBathColumnKey(key: CncTelegramTodayColumn['key']): boolean {
  return key === 'baths'
    || key === 'baths_ready'
    || key === 'baths_laminated'
    || key === 'completed_baths';
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

function dateOnlyPrefix(value: string | null | undefined): string | undefined {
  const match = value?.trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? dateOnly(match[1] ?? null) : undefined;
}

interface CncPlannedOrderMatcher {
  orderIds: Set<number>;
  orderKeys: Set<string>;
}

function buildCncPlannedOrderMatcher(
  cards: readonly OrderStatusBoardCard[],
  plannedDate: string,
): CncPlannedOrderMatcher {
  const orderIds = new Set<number>();
  const orderKeys = new Set<string>();
  for (const card of cards) {
    if (dateOnlyPrefix(card.plannedCompletionDate) !== plannedDate) continue;
    if (isPositiveInteger(card.orderId)) orderIds.add(card.orderId);
    addCncPlannedOrderKey(orderKeys, card.orderName);
    addCncPlannedOrderKey(orderKeys, card.fullNumber);
  }
  return { orderIds, orderKeys };
}

function cncItemMatchesPlannedOrder(
  matcher: CncPlannedOrderMatcher,
  orderName: string | null | undefined,
  ...orderIds: Array<number | null | undefined>
): boolean {
  for (const orderId of orderIds) {
    if (isPositiveInteger(orderId) && matcher.orderIds.has(orderId)) return true;
  }
  const orderKey = normalizeCncOrderKey(orderName);
  return Boolean(orderKey && matcher.orderKeys.has(orderKey));
}

function addCncPlannedOrderKey(target: Set<string>, value: string | null | undefined): void {
  const orderKey = normalizeCncOrderKey(value);
  if (orderKey) target.add(orderKey);
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

function positiveIntegerOrNull(value: number | null | undefined): number | null {
  return isPositiveInteger(value) ? value : null;
}

function nonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

function resolveCncOrderId(
  orderId: number | null | undefined,
  orderName: string | null | undefined,
  orderIdByOrderKey: ReadonlyMap<string, number>,
): number | null {
  const safeOrderId = positiveIntegerOrNull(orderId);
  if (safeOrderId !== null) return safeOrderId;
  const orderKey = normalizeCncOrderKey(orderName);
  return orderKey ? orderIdByOrderKey.get(orderKey) ?? null : null;
}

function addNestedQuantity(
  map: Map<number, Map<number, number>>,
  orderId: number,
  itemKey: number,
  quantity: number,
): void {
  let orderMap = map.get(orderId);
  if (!orderMap) {
    orderMap = new Map();
    map.set(orderId, orderMap);
  }
  orderMap.set(itemKey, (orderMap.get(itemKey) ?? 0) + quantity);
}

function compareCncMissingDetails(
  left: CncOrderMissingDetail,
  right: CncOrderMissingDetail,
): number {
  if (left.detailNumber !== null && right.detailNumber !== null) {
    return left.detailNumber - right.detailNumber || left.detailId - right.detailId;
  }
  if (left.detailNumber !== null) return -1;
  if (right.detailNumber !== null) return 1;
  return left.detailId - right.detailId;
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
