import { describe, expect, it } from 'vitest';
import type {
  OrderStatusBoardCard,
  OrderStatusBoardResponse,
} from '../../api/types/orderStatusBoardApi.types';
import {
  mergeOrderStatusBoardColumnPage,
  parseOrderStatusBoardViewState,
  serializeOrderStatusBoardViewState,
  toOrderStatusBoardQuery,
} from './model';

describe('order status board model', () => {
  it('round-trips shareable URL state and API query', () => {
    const state = parseOrderStatusBoardViewState(
      new URLSearchParams(
        'board=production&q=ABC&mine=1&overdue=1&plannedFrom=2026-07-01&hideEmpty=1',
      ),
    );
    expect(state).toMatchObject({
      board: 'production',
      search: 'ABC',
      onlyMyOrders: true,
      overdueOnly: true,
      plannedFrom: '2026-07-01',
      hideEmpty: true,
    });
    expect(serializeOrderStatusBoardViewState(state).toString()).toContain(
      'board=production',
    );
    expect(toOrderStatusBoardQuery(state, { column: '7', cursor: 'next' })).toMatchObject({
      board: 'production',
      search: 'ABC',
      column: '7',
      cursor: 'next',
      limit: 24,
    });
  });

  it('drops impossible dates from a hand-edited shared URL', () => {
    const state = parseOrderStatusBoardViewState(
      new URLSearchParams('plannedFrom=2026-02-30&plannedTo=0000-01-01'),
    );
    expect(state.plannedFrom).toBeUndefined();
    expect(state.plannedTo).toBeUndefined();
  });

  it('atomically appends and removes externally moved cards from other columns', () => {
    const current = board([
      column('1', [card(1), card(2)], 2, 'cursor-1'),
      column('2', [card(3)], 2, 'cursor-2'),
    ]);
    const incoming = board([column('2', [card(2), card(4)], 3, null)]);
    const result = mergeOrderStatusBoardColumnPage(current, incoming, 'filter');

    expect(result.kind).toBe('applied');
    expect(result.board.columns[0]?.cards.map((item) => item.orderId)).toEqual([1]);
    expect(result.board.columns[1]?.cards.map((item) => item.orderId)).toEqual([3, 2, 4]);
  });

  it('discards stale filter pages and detects missing columns', () => {
    const current = board([column('1', [card(1)], 1, null)]);
    expect(
      mergeOrderStatusBoardColumnPage(
        current,
        { ...board([column('1', [card(2)], 1, null)]), filterKey: 'old' },
        'filter',
      ).kind,
    ).toBe('discarded');
    expect(
      mergeOrderStatusBoardColumnPage(
        current,
        board([column('missing', [card(2)], 1, null)]),
        'filter',
      ).kind,
    ).toBe('anomaly');
  });
});

function board(columns: OrderStatusBoardResponse['columns']): OrderStatusBoardResponse {
  return {
    board: 'order',
    generatedAt: '2026-07-19T00:00:00.000Z',
    filterKey: 'filter',
    financialsVisible: false,
    columns,
  };
}

function column(
  key: string,
  cards: OrderStatusBoardCard[],
  total: number,
  nextCursor: string | null,
) {
  return {
    key,
    status: {
      id: Number(key) || null,
      code: null,
      name: key,
      color: null,
      sortOrder: Number(key),
      isActive: true,
    },
    total,
    cards,
    nextCursor,
  };
}

function card(orderId: number): OrderStatusBoardCard {
  return {
    orderId,
    orderName: String(orderId),
    fullNumber: `A-${orderId}`,
    clientId: 1,
    clientName: null,
    priority: 100,
    plannedCompletionDate: null,
    pastPlannedDate: false,
    orderStatusId: 1,
    orderStatusName: 'Новый',
    productionStatusId: null,
    productionStatusName: null,
    productionStatusFromDetailsEnabled: true,
    paymentStatusId: null,
    paymentStatusName: null,
    finalAmount: null,
    paidAmount: null,
    debtAmount: null,
    partsCount: 0,
    totalArea: 0,
    managerId: null,
    managerName: null,
    updatedAt: '2026-07-19T00:00:00.000Z',
    version: 1,
    canChangeOrderStatus: false,
    canChangeProductionStatus: false,
  };
}
