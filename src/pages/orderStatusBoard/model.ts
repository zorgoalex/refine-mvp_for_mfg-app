import type {
  OrderStatusBoardColumn,
  OrderStatusBoardQuery,
  OrderStatusBoardResponse,
  OrderStatusBoardType,
} from '../../api/types/orderStatusBoardApi.types';

const COMPLETED_ORDER_STATUS_NAMES = new Set(['завершен', 'завершён']);

export interface OrderStatusBoardViewState {
  board: OrderStatusBoardType;
  search: string;
  onlyMyOrders: boolean;
  overdueOnly: boolean;
  showDone: boolean;
  plannedFrom?: string;
  plannedTo?: string;
  hideEmpty: boolean;
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
): OrderStatusBoardViewState {
  const board = params.get('board') === 'production' ? 'production' : 'order';
  const plannedFrom = dateOnly(params.get('plannedFrom'));
  const plannedTo = dateOnly(params.get('plannedTo'));
  return {
    board,
    search: params.get('q')?.trim() ?? '',
    onlyMyOrders: params.get('mine') === '1',
    overdueOnly: params.get('overdue') === '1',
    showDone: params.get('showDone') === '1',
    ...(plannedFrom ? { plannedFrom } : {}),
    ...(plannedTo ? { plannedTo } : {}),
    hideEmpty: params.get('hideEmpty') === '1',
  };
}

export function serializeOrderStatusBoardViewState(
  state: OrderStatusBoardViewState,
): URLSearchParams {
  const params = new URLSearchParams();
  if (state.board !== 'order') params.set('board', state.board);
  if (state.search.trim()) params.set('q', state.search.trim());
  if (state.onlyMyOrders) params.set('mine', '1');
  if (state.overdueOnly) params.set('overdue', '1');
  if (state.showDone) params.set('showDone', '1');
  if (state.plannedFrom) params.set('plannedFrom', state.plannedFrom);
  if (state.plannedTo) params.set('plannedTo', state.plannedTo);
  if (state.hideEmpty) params.set('hideEmpty', '1');
  return params;
}

export function toOrderStatusBoardQuery(
  state: OrderStatusBoardViewState,
  override: Partial<Pick<OrderStatusBoardQuery, 'column' | 'cursor'>> = {},
): OrderStatusBoardQuery {
  return {
    board: state.board,
    limit: 24,
    ...(state.search.trim() ? { search: state.search.trim() } : {}),
    onlyMyOrders: state.onlyMyOrders,
    overdueOnly: state.overdueOnly,
    ...(state.board === 'production' && state.showDone
      ? { includeDone: true }
      : {}),
    ...(state.plannedFrom ? { plannedFrom: state.plannedFrom } : {}),
    ...(state.plannedTo ? { plannedTo: state.plannedTo } : {}),
    ...override,
  };
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
