import { describe, expect, it } from 'vitest';
import type { CncTelegramTodayColumn } from '../../api/types/cncTelegramApi.types';
import type {
  OrderStatusBoardCard,
  OrderStatusBoardColumn,
  OrderStatusBoardResponse,
} from '../../api/types/orderStatusBoardApi.types';
import {
  buildCncOrderSearchDateRange,
  buildCncOrderFilterOptions,
  collectCncOrderIds,
  filterBoardColumns,
  filterCncBazisCutSetsByMissingBathDetails,
  filterCncBathColumnsByMachineOrderMatches,
  filterCncBathColumnsByOrderStatuses,
  filterCncTodayColumnsByOrders,
  isCncCardSummaryOnly,
  isCncOrderHiddenFromMdfBoard,
  mergeOrderStatusBoardColumnPage,
  parseOrderStatusBoardViewState,
  resolveDefaultMdfBoardHiddenOrderStatusIds,
  resolveMdfBoardHiddenOrderStatusIds,
  resolveMdfBoardHiddenProductionStatusIds,
  serializeOrderStatusBoardViewState,
  toggleCncCardStandardOverride,
  toOrderStatusBoardQuery,
} from './model';

describe('order status board model', () => {
  it('toggles a temporary standard-view override for only one compact MDF card', () => {
    const first = toggleCncCardStandardOverride(new Set(), 'packet:p-1');

    expect(first).toEqual(new Set(['packet:p-1']));
    expect(isCncCardSummaryOnly('compact', first, 'packet:p-1')).toBe(false);
    expect(isCncCardSummaryOnly('compact', first, 'bath:b-1')).toBe(true);
    expect(isCncCardSummaryOnly('standard', first, 'bath:b-1')).toBe(false);

    const second = toggleCncCardStandardOverride(first, 'packet:p-1');
    expect(second).toEqual(new Set());
    expect(first).toEqual(new Set(['packet:p-1']));
  });

  it('forces the active detailed bath out of compact summary view', () => {
    expect(
      isCncCardSummaryOnly('compact', new Set(), 'bath:b-1', true),
    ).toBe(false);
    expect(
      isCncCardSummaryOnly('compact', new Set(), 'bath:b-2', false),
    ).toBe(true);
  });

  it('hides the completed column only on the order board', () => {
    const completed = column('completed', [], 0, null);
    const columns: OrderStatusBoardColumn[] = [
      column('active', [], 0, null),
      {
        ...completed,
        status: {
          ...completed.status,
          name: ' Завершён ',
        },
      },
    ];

    expect(filterBoardColumns('order', columns).map((item) => item.key)).toEqual([
      'active',
    ]);
    expect(filterBoardColumns('production', columns)).toEqual(columns);
  });

  it('hides localized terminal production statuses by default and reveals them explicitly', () => {
    const done = column('21', [], 0, null);
    done.status.name = ' Done ';
    done.status.code = 'done_74650149756a47dd997c95e097acbd14';
    const completed = column('22', [], 0, null);
    completed.status.name = ' Завершено ';
    completed.status.code = 'zaversheno_0123456789abcdef0123456789abcdef';
    const columns = [column('20', [], 0, null), done, completed];

    expect(filterBoardColumns('production', columns).map((item) => item.key)).toEqual([
      '20',
    ]);
    expect(filterBoardColumns('production', columns, true)).toBe(columns);
  });

  it('round-trips shareable URL state and API query', () => {
    const state = parseOrderStatusBoardViewState(
      new URLSearchParams(
        'board=production&q=ABC&mine=1&overdue=1&showDone=1&plannedFrom=2026-07-01&hideEmpty=1',
      ),
    );
    expect(state).toMatchObject({
      view: 'production',
      search: 'ABC',
      onlyMyOrders: true,
      overdueOnly: true,
      showDone: true,
      plannedFrom: '2026-07-01',
      hideEmpty: true,
    });
    expect(serializeOrderStatusBoardViewState(state).toString()).toContain(
      'board=production',
    );
    expect(serializeOrderStatusBoardViewState(state).toString()).toContain(
      'showDone=1',
    );
    expect(toOrderStatusBoardQuery(state, { column: '7', cursor: 'next' })).toMatchObject({
      board: 'production',
      search: 'ABC',
      column: '7',
      cursor: 'next',
      limit: 24,
      includeDone: true,
    });
  });

  it('keeps CNC today as visual flow without changing status-board API type', () => {
    const disabled = parseOrderStatusBoardViewState(new URLSearchParams('flow=cnc'));
    const state = parseOrderStatusBoardViewState(
      new URLSearchParams('flow=cnc&date=2026-07-23&period=2w&order=2706&order=2712'),
      {
        cncTelegram: true,
      },
    );

    expect(disabled.view).toBe('order');
    expect(state.view).toBe('cnc_today');
    expect(state.cncWorkday).toBe('2026-07-23');
    expect(state.cncOrderSearchPeriod).toBe('2w');
    expect(state.cncOrderFilters).toEqual(['2706', '2712']);
    const serialized = serializeOrderStatusBoardViewState(state);
    expect(serialized.toString()).toContain('flow=cnc');
    expect(serialized.toString()).toContain('date=2026-07-23');
    expect(serialized.toString()).toContain('period=2w');
    expect(serialized.getAll('order')).toEqual(['2706', '2712']);
    expect(toOrderStatusBoardQuery(state)).toMatchObject({ board: 'order' });

    const defaultPeriodState = parseOrderStatusBoardViewState(
      new URLSearchParams('flow=cnc&date=2026-07-23'),
      { cncTelegram: true },
    );
    expect(defaultPeriodState.cncOrderSearchPeriod).toBe('1w');
  });

  it('builds CNC order search ranges from the selected board date', () => {
    expect(buildCncOrderSearchDateRange('2026-07-23', undefined)).toEqual({
      dateFrom: '2026-07-17',
      dateTo: '2026-07-23',
      days: 7,
    });
    expect(buildCncOrderSearchDateRange('2026-07-23', '1d')).toEqual({
      dateFrom: '2026-07-23',
      dateTo: '2026-07-23',
      days: 1,
    });
    expect(buildCncOrderSearchDateRange('2026-07-23', '1w')).toEqual({
      dateFrom: '2026-07-17',
      dateTo: '2026-07-23',
      days: 7,
    });
    expect(buildCncOrderSearchDateRange('2026-07-23', '2w')).toEqual({
      dateFrom: '2026-07-10',
      dateTo: '2026-07-23',
      days: 14,
    });
    expect(buildCncOrderSearchDateRange('2026-03-01', '1m')).toEqual({
      dateFrom: '2026-01-30',
      dateTo: '2026-03-01',
      days: 31,
    });
  });

  it('filters CNC packet and bath cards by exact order number', () => {
    const columns = [
      {
        key: 'parsed',
        title: 'Файлы на станке',
        total: 2,
        packets: [
          cncPacket('p-2706', ['2706', '2707']),
          cncPacket('p-2712', ['2712']),
        ],
        baths: [],
      },
      {
        key: 'baths',
        title: 'Ванны',
        total: 2,
        packets: [],
        baths: [
          cncBath('b-2706', ['2706']),
          cncBath('b-2712', ['2712']),
        ],
      },
    ] as CncTelegramTodayColumn[];

    expect(buildCncOrderFilterOptions(columns)).toEqual(['2706', '2707', '2712']);

    const filtered = filterCncTodayColumnsByOrders(columns, [' 2706 ', '2712']);
    expect(filtered[0]?.packets.map((packet) => packet.packetId)).toEqual([
      'p-2706',
      'p-2712',
    ]);
    expect(filtered[0]?.total).toBe(2);
    expect(filtered[1]?.baths.map((bath) => bath.bathCardId)).toEqual([
      'b-2706',
      'b-2712',
    ]);
    expect(filtered[1]?.total).toBe(2);

    const partial = filterCncTodayColumnsByOrders(columns, ['270']);
    expect(partial[0]?.packets).toEqual([]);
    expect(partial[0]?.total).toBe(0);
    expect(partial[1]?.baths).toEqual([]);
    expect(partial[1]?.total).toBe(0);
  });

  it('keeps only bath cards with order numbers present in machine file cards', () => {
    const columns = [
      {
        key: 'parsed',
        title: 'Файлы на станке',
        total: 1,
        packets: [cncPacket('p-2706', ['2706'])],
        baths: [],
        bazisCutSets: [cncBazisCutSet(8, [{ orderName: '3000', orderId: 3000, detailId: 8001 }])],
      },
      {
        key: 'completed',
        title: 'Распилено',
        total: 1,
        packets: [cncPacket('p-2712', ['2712'])],
        baths: [],
      },
      {
        key: 'baths',
        title: 'Карты ванн',
        total: 3,
        packets: [],
        baths: [
          cncBath('b-2706', ['2706']),
          cncBath('b-2712', ['2712']),
          cncBath('b-3000', ['3000']),
        ],
      },
    ] as CncTelegramTodayColumn[];

    const filtered = filterCncBathColumnsByMachineOrderMatches(columns);

    expect(filtered[2]?.baths.map((bath) => bath.bathCardId)).toEqual([
      'b-2706',
      'b-2712',
      'b-3000',
    ]);
    expect(filtered[2]?.total).toBe(3);
  });

  it('keeps Basis-cut cards only for bath details missing from machine files', () => {
    const columns = [
      {
        key: 'parsed',
        title: 'Файлы на станке',
        total: 2,
        packets: [cncPacket('p-2712', ['2712'], [2712], [2712], [7002])],
        baths: [],
        bazisCutSets: [
          cncBazisCutSet(8, [{ orderName: '2706', orderId: 2706, detailId: 7001 }]),
          cncBazisCutSet(9, [{ orderName: '2712', orderId: 2712, detailId: 7002 }]),
        ],
      },
      {
        key: 'baths',
        title: 'Карты ванн',
        total: 1,
        packets: [],
        baths: [{
          ...cncBath('b-2706', ['2706'], [2706]),
          items: [{
            bathItemId: 'b-2706-7001',
            orderName: '2706',
            orderId: 2706,
            detailId: 7001,
          }, {
            bathItemId: 'b-2706-7002',
            orderName: '2712',
            orderId: 2712,
            detailId: 7002,
          }],
        }],
        bazisCutSets: [],
      },
    ] as CncTelegramTodayColumn[];

    const filtered = filterCncBazisCutSetsByMissingBathDetails(columns);

    expect(filtered[0]?.bazisCutSets?.map((card) => card.bazisCutSetId)).toEqual([8]);
    expect(filtered[0]?.total).toBe(2);
  });

  it('collects unique ERP order ids from visible CNC cards', () => {
    const columns = [
      {
        key: 'parsed',
        title: 'Файлы на станке',
        total: 1,
        packets: [
          cncPacket('p-2706', ['2706', '2712'], [2706, null], [null, 2712]),
        ],
        baths: [],
        bazisCutSets: [cncBazisCutSet(8, [{ orderName: '2800', orderId: 2800, detailId: 8001 }])],
      },
      {
        key: 'baths',
        title: 'Карты ванн',
        total: 1,
        packets: [],
        baths: [cncBath('b-2700', ['2700', '2706'], [2700, 2706])],
      },
    ] as CncTelegramTodayColumn[];

    expect(collectCncOrderIds(columns)).toEqual([2700, 2706, 2712, 2800]);
  });

  it('hides MDF orders for default production names until explicit setting exists', () => {
    for (const productionStatusName of [' Закатан ', 'УПАКОВАН', 'выдан']) {
      expect(isCncOrderHiddenFromMdfBoard({
        ...card(2700),
        productionStatusName,
      })).toBe(true);
    }
    for (const orderStatusName of ['Выдан', 'Завершен', 'Завершён']) {
      expect(isCncOrderHiddenFromMdfBoard({
        ...card(2700),
        orderStatusName,
      })).toBe(true);
    }
    expect(isCncOrderHiddenFromMdfBoard({
      ...card(2700),
      orderStatusName: 'Готов к выдаче',
    })).toBe(false);
    expect(isCncOrderHiddenFromMdfBoard({
      ...card(2700),
      orderStatusName: 'Архивный пользовательский',
      orderStatusIssuedOrLater: true,
    })).toBe(true);
    expect(isCncOrderHiddenFromMdfBoard({
      ...card(2700),
      productionStatusName: 'Закатка',
      orderStatusName: 'В работе',
    })).toBe(false);
    expect(isCncOrderHiddenFromMdfBoard({
      ...card(2700),
      productionStatusId: 10,
      productionStatusName: 'Закатан',
      orderStatusName: 'В работе',
    }, new Set([11]))).toBe(false);
    expect(isCncOrderHiddenFromMdfBoard({
      ...card(2700),
      productionStatusId: 11,
      productionStatusName: 'На отгрузку',
      orderStatusName: 'В работе',
    }, new Set([11]))).toBe(true);
    expect(isCncOrderHiddenFromMdfBoard({
      ...card(2700),
      orderStatusId: 7,
      orderStatusName: 'Готов к выдаче',
    }, new Set(), new Set([7]))).toBe(true);
    expect(isCncOrderHiddenFromMdfBoard({
      ...card(2700),
      orderStatusId: 8,
      orderStatusName: 'Выдан',
      orderStatusIssuedOrLater: true,
    }, new Set(), new Set())).toBe(false);
  });

  it('resolves explicit MDF board hidden production statuses by id', () => {
    const columns = [
      {
        key: 'rolled',
        status: {
          id: 10,
          code: 'rolled',
          name: 'Закатан',
          color: null,
          sortOrder: 10,
          isActive: true,
        },
        total: 0,
        cards: [],
        nextCursor: null,
      },
      {
        key: 'packed',
        status: {
          id: 11,
          code: 'packed',
          name: 'Упакован',
          color: null,
          sortOrder: 11,
          isActive: true,
        },
        total: 0,
        cards: [],
        nextCursor: null,
      },
    ];

    expect(Array.from(resolveMdfBoardHiddenProductionStatusIds(columns, null))).toEqual([10, 11]);
    expect(Array.from(resolveMdfBoardHiddenProductionStatusIds(columns, {
      productionStatusIds: [11, 11, 0, Number.NaN, 10],
    }))).toEqual([10, 11]);
    expect(Array.from(resolveMdfBoardHiddenProductionStatusIds(columns, {
      productionStatusIds: [],
      orderStatusIds: [],
    }))).toEqual([]);
  });

  it('resolves explicit MDF board hidden order statuses without changing legacy settings', () => {
    expect(resolveMdfBoardHiddenOrderStatusIds(null)).toBeUndefined();
    expect(resolveMdfBoardHiddenOrderStatusIds({
      productionStatusIds: [10],
    })).toBeUndefined();
    expect(Array.from(resolveMdfBoardHiddenOrderStatusIds({
      productionStatusIds: [10],
      orderStatusIds: [8, 8, 0, Number.NaN, 7],
    }) ?? [])).toEqual([7, 8]);
    expect(Array.from(resolveMdfBoardHiddenOrderStatusIds({
      productionStatusIds: [10],
      orderStatusIds: [],
    }) ?? [])).toEqual([]);
  });

  it('derives legacy MDF order-status defaults from «Выдан» sort order with name fallback', () => {
    expect(resolveDefaultMdfBoardHiddenOrderStatusIds([
      { id: 5, name: 'В работе', sortOrder: 5 },
      { id: 8, name: ' Выдан ', sortOrder: 20 },
      { id: 9, name: 'Архивный пользовательский', sortOrder: 30 },
      { id: 10, name: 'Завершён' },
    ])).toEqual([8, 9, 10]);
    expect(resolveDefaultMdfBoardHiddenOrderStatusIds([
      { id: 5, name: 'В работе', sortOrder: 5 },
      { id: 8, name: 'Выдан' },
      { id: 10, name: 'Завершен', sortOrder: 10 },
    ])).toEqual([8, 10]);
  });

  it('removes a bath only when every linked order has left the MDF board', () => {
    const columns = [
      {
        key: 'baths',
        title: 'Карты ванн',
        total: 5,
        packets: [],
        baths: [
          cncBath('terminal', ['2700'], [2700]),
          cncBath('cross-status-terminal', ['2700', '2712'], [2700, 2712]),
          cncBath('mixed', ['2700', '2706'], [2700, 2706]),
          cncBath('order-terminal', ['2712'], [2712]),
          cncBath('status-missing', ['3000'], [3000]),
        ],
      },
      {
        key: 'baths_ready',
        title: 'Готовы к закатке',
        total: 1,
        packets: [],
        baths: [cncBath('ready-inconsistent', ['2700'], [2700])],
      },
      {
        key: 'baths_laminated',
        title: 'Закатаны/выданы',
        total: 1,
        packets: [],
        baths: [cncBath('archived', ['2700'], [2700])],
      },
    ] as CncTelegramTodayColumn[];
    const cards = [
      { ...card(2700), productionStatusId: 10, productionStatusName: 'Закатан' },
      { ...card(2706), productionStatusId: 9, productionStatusName: 'К закатке' },
      { ...card(2712), orderStatusId: 7, orderStatusName: 'Готов к выдаче' },
    ];

    const filtered = filterCncBathColumnsByOrderStatuses(
      columns,
      cards,
      new Set([10]),
      new Set([7]),
    );

    expect(filtered[0]?.baths.map((bath) => bath.bathCardId)).toEqual([
      'mixed',
      'status-missing',
    ]);
    expect(filtered[0]?.total).toBe(2);
    expect(filtered[1]?.baths.map((bath) => bath.bathCardId)).toEqual(['ready-inconsistent']);
    expect(filtered[2]?.baths.map((bath) => bath.bathCardId)).toEqual(['archived']);
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
    orderStatusIssuedOrLater: false,
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

function cncPacket(
  packetId: string,
  orderNames: string[],
  orderIds: Array<number | null> = [],
  matchOrderIds: Array<number | null> = [],
  matchDetailIds: Array<number | null> = [],
) {
  return {
    packetId,
    externalPacketKey: packetId,
    programName: null,
    materialName: 'МДФ',
    comments: [],
    completionStatus: 'pending',
    thumbsUp: false,
    items: orderNames.map((orderName, index) => ({
      packetItemId: `${packetId}-${index}`,
      orderName,
      orderId: orderIds[index] ?? null,
      matchOrderId: matchOrderIds[index] ?? null,
      matchDetailId: matchDetailIds[index] ?? null,
    })),
  };
}

function cncBath(
  bathCardId: string,
  orderNames: string[],
  orderIds: number[] = [],
) {
  return {
    bathCardId,
    items: orderNames.map((orderName, index) => ({
      bathItemId: `${bathCardId}-${index}`,
      orderName,
      orderId: orderIds[index] ?? Number(orderName),
    })),
  };
}

function cncBazisCutSet(
  bazisCutSetId: number,
  items: Array<{ orderName: string; orderId: number | null; detailId: number | null }>,
) {
  return {
    bazisCutSetId,
    name: `БР-${bazisCutSetId}`,
    orderCount: new Set(items.map((item) => item.orderId)).size,
    positionCount: items.length,
    itemQuantityTotal: items.length,
    items: items.map((item) => ({
      ...item,
      orderDeleted: false,
      detailNumber: null,
      widthMm: null,
      heightMm: null,
      quantity: 1,
    })),
  };
}
