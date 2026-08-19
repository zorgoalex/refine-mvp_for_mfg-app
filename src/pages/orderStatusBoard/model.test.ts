import { describe, expect, it } from 'vitest';
import type {
  CncTelegramBathCard,
  CncTelegramPacket,
  CncTelegramTodayColumn,
} from '../../api/types/cncTelegramApi.types';
import type {
  OrderStatusBoardCard,
  OrderStatusBoardResponse,
} from '../../api/types/orderStatusBoardApi.types';
import {
  buildCncBoardDisplayColumns,
  buildCncPacketLabelCoverage,
  cncManualMoveStorageKey,
  isCncManualMoveAllowed,
  type CncBoardManualMoveState,
  type CncTelegramTodayDisplayColumn,
  type CncTelegramTodayDisplayColumnKey,
} from './OrderStatusBoardPage';
import {
  buildCncOrderSearchDateRange,
  buildCncOrderFilterOptions,
  filterBoardColumns,
  filterCncBathColumnsByMachineOrderMatches,
  filterCncTodayColumnsByOrders,
  mergeOrderStatusBoardColumnPage,
  parseOrderStatusBoardViewState,
  serializeOrderStatusBoardViewState,
  toOrderStatusBoardQuery,
} from './model';

describe('order status board model', () => {
  it('hides the completed column only on the order board', () => {
    const completed = column('completed', [], 0, null);
    const columns = [
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
      new URLSearchParams('flow=cnc&date=2026-07-23&period=2w&order=2706&order=2712&cardKind=bath&cardId=cut-result%3A42'),
      {
        cncTelegram: true,
      },
    );

    expect(disabled.view).toBe('order');
    expect(state.view).toBe('cnc_today');
    expect(state.cncWorkday).toBe('2026-07-23');
    expect(state.cncOrderSearchPeriod).toBe('2w');
    expect(state.cncOrderFilters).toEqual(['2706', '2712']);
    expect(state.cncCardKind).toBe('bath');
    expect(state.cncCardId).toBe('cut-result:42');
    const serialized = serializeOrderStatusBoardViewState(state);
    expect(serialized.toString()).toContain('flow=cnc');
    expect(serialized.toString()).toContain('date=2026-07-23');
    expect(serialized.toString()).toContain('period=2w');
    expect(serialized.getAll('order')).toEqual(['2706', '2712']);
    expect(serialized.get('cardKind')).toBe('bath');
    expect(serialized.get('cardId')).toBe('cut-result:42');
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

  it('explains incomplete CNC packet label coverage without blocking generation', () => {
    const packet = cncPacket('p-labels', ['2706'], {
      itemCount: 3,
      itemQuantityTotal: 11,
      items: [
        cncPacketItem('p-labels-1', {
          orderName: '2706',
          detailNumber: 1,
          matchDetailId: 101,
          quantity: 6,
        }),
        cncPacketItem('p-labels-2', {
          orderName: '2706',
          detailNumber: 2,
          matchDetailId: 102,
          quantity: 3,
        }),
        cncPacketItem('p-labels-3', {
          orderName: '2706',
          detailNumber: 3,
          matchDetailId: 103,
          quantity: 2,
        }),
      ],
    });

    const coverage = buildCncPacketLabelCoverage(packet, {
      cutGroupId: 1,
      sheetIndex: 0,
      sheetNumber: 1,
      variant: 'auto',
      detailIds: [
        101, 101, 101, 101, 101, 101,
        102, 102, 102,
      ],
    });

    expect(coverage.expectedCount).toBe(11);
    expect(coverage.includedCount).toBe(9);
    expect(coverage.issues).toEqual([
      expect.objectContaining({
        label: '2706 #3 450×300',
        expectedQuantity: 2,
        includedQuantity: 0,
        missingQuantity: 2,
        reason: 'в импортированном SVG-листе нет размещения этой детали',
      }),
    ]);
  });

  it('keeps only bath cards with order numbers present in machine file cards', () => {
    const columns = [
      {
        key: 'parsed',
        title: 'Файлы на станке',
        total: 1,
        packets: [cncPacket('p-2706', ['2706'])],
        baths: [],
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
    ]);
    expect(filtered[2]?.total).toBe(2);
  });

  it('applies MDF manual moves only within card-specific column groups', () => {
    expect(isCncManualMoveAllowed('packet', 'parsed')).toBe(true);
    expect(isCncManualMoveAllowed('packet', 'completed')).toBe(true);
    expect(isCncManualMoveAllowed('packet', 'baths_rolled')).toBe(false);
    expect(isCncManualMoveAllowed('bath', 'baths')).toBe(true);
    expect(isCncManualMoveAllowed('bath', 'baths_ready')).toBe(true);
    expect(isCncManualMoveAllowed('bath', 'baths_rolled')).toBe(true);
    expect(isCncManualMoveAllowed('bath', 'orders_ready')).toBe(false);
    expect(isCncManualMoveAllowed('order', 'orders')).toBe(true);
    expect(isCncManualMoveAllowed('order', 'orders_ready')).toBe(true);
    expect(isCncManualMoveAllowed('order', 'orders_issued')).toBe(true);
    expect(isCncManualMoveAllowed('order', 'completed')).toBe(false);
  });

  it('keeps an explicitly created bath when machine-file matching is required', () => {
    const columns = [{
      key: 'baths',
      title: 'Карты ванн',
      total: 1,
      packets: [],
      baths: [cncBath('forced-bath', ['9999'], { forced: true })],
    }] as CncTelegramTodayColumn[];

    const filtered = filterCncBathColumnsByMachineOrderMatches(columns);
    expect(filtered[0]?.baths.map((bath) => bath.bathCardId)).toEqual(['forced-bath']);
  });

  it('builds MDF display columns with manual packet, bath and order moves', () => {
    const columns = [
      cncTodayColumn('parsed', [
        cncPacket('packet-pending', ['1001']),
      ]),
      cncTodayColumn('completed', [
        cncPacket('packet-ready', ['2002'], { completionStatus: 'completed' }),
      ]),
      cncTodayColumn('baths', [], [
        cncBath('bath-ready', ['3003'], { ready: true }),
      ]),
    ];
    const manualMoves: CncBoardManualMoveState = {
      [cncManualMoveStorageKey('packet', 'packet-pending')]: 'completed',
      [cncManualMoveStorageKey('bath', 'bath-ready')]: 'baths_rolled',
      [cncManualMoveStorageKey('order', 'id:2002')]: 'orders_issued',
    };

    const display = cncDisplayMap(buildCncBoardDisplayColumns(columns, manualMoves));

    expect(display.get('completed')?.packets.map((packet) => packet.packetId)).toEqual([
      'packet-pending',
      'packet-ready',
    ]);
    expect(display.get('baths_rolled')?.baths.map((bath) => bath.bathCardId)).toEqual([
      'bath-ready',
    ]);
    expect(display.get('orders_ready')?.orders.map((order) => ({
      key: order.orderKey,
      cut: order.cutDetails,
      rolled: order.rolledDetails,
      left: order.remainingDetails,
    }))).toEqual([
      { key: 'id:1001', cut: 1, rolled: 0, left: 0 },
      { key: 'id:3003', cut: 0, rolled: 1, left: 0 },
    ]);
    expect(display.get('orders_issued')?.orders.map((order) => ({
      key: order.orderKey,
      cut: order.cutDetails,
      rolled: order.rolledDetails,
      left: order.remainingDetails,
    }))).toEqual([
      { key: 'id:2002', cut: 1, rolled: 0, left: 0 },
    ]);
  });

  it('sorts MDF order cards by order number by default and supports sort settings', () => {
    const columns = [
      cncTodayColumn('parsed', [
        cncPacket('packet-10', ['10'], { sourceUpdatedAt: '2026-07-19T09:00:00.000Z' }),
        cncPacket('packet-2', ['2'], { sourceUpdatedAt: '2026-07-19T11:00:00.000Z' }),
        cncPacket('packet-1', ['1'], { sourceUpdatedAt: '2026-07-19T10:00:00.000Z' }),
      ]),
    ];

    const defaultDisplay = cncDisplayMap(buildCncBoardDisplayColumns(columns, {}));
    expect(defaultDisplay.get('orders')?.orders.map((order) => order.orderName)).toEqual([
      '1',
      '2',
      '10',
    ]);

    const updatedDescDisplay = cncDisplayMap(
      buildCncBoardDisplayColumns(columns, {}, {
        field: 'sourceUpdatedAt',
        direction: 'desc',
      }),
    );
    expect(updatedDescDisplay.get('orders')?.orders.map((order) => order.orderName)).toEqual([
      '2',
      '1',
      '10',
    ]);
  });

  it('keeps completed packet-only MDF orders ready and ignores stale manual targets', () => {
    const columns = [
      cncTodayColumn('completed', [
        cncPacket('packet-ready', ['2002'], { completionStatus: 'completed' }),
      ]),
    ];
    const display = cncDisplayMap(buildCncBoardDisplayColumns(columns, {
      [cncManualMoveStorageKey('packet', 'packet-ready')]: 'baths',
    }));

    expect(display.get('completed')?.packets.map((packet) => packet.packetId)).toEqual([
      'packet-ready',
    ]);
    expect(display.get('orders_ready')?.orders.map((order) => ({
      key: order.orderKey,
      cut: order.cutDetails,
      rolled: order.rolledDetails,
      left: order.remainingDetails,
    }))).toEqual([
      { key: 'id:2002', cut: 1, rolled: 0, left: 0 },
    ]);
    expect(display.get('orders')?.orders).toEqual([]);
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

function cncTodayColumn(
  key: CncTelegramTodayColumn['key'],
  packets: CncTelegramPacket[] = [],
  baths: CncTelegramBathCard[] = [],
): CncTelegramTodayColumn {
  return {
    key,
    title: key,
    total: packets.length + baths.length,
    packets,
    baths,
  };
}

function cncDisplayMap(
  columns: CncTelegramTodayDisplayColumn[],
): Map<CncTelegramTodayDisplayColumnKey, CncTelegramTodayDisplayColumn> {
  return new Map(columns.map((columnItem) => [columnItem.key, columnItem]));
}

function cncPacket(
  packetId: string,
  orderNames: string[],
  overrides: Partial<CncTelegramPacket> = {},
): CncTelegramPacket {
  const items = orderNames.map((orderName, index) => ({
    packetItemId: `${packetId}-${index}`,
    sourceItemKey: `${packetId}-${index}`,
    orderName,
    orderId: Number(orderName) || null,
    detailNumber: index + 1,
    widthMm: null,
    heightMm: null,
    quantity: 1,
    source: 'manual' as const,
    confidence: 1,
    matchOrderId: Number(orderName) || null,
    matchDetailId: null,
    matchStatus: 'matched' as const,
    reviewNote: null,
  }));
  return {
    packetId,
    externalPacketKey: packetId,
    sourceChatId: 'test',
    sourceMessageId: null,
    sourceThreadId: null,
    sourceVersion: 1,
    sourceCreatedAt: null,
    sourceUpdatedAt: '2026-07-19T00:00:00.000Z',
    workday: '2026-07-19',
    machine: null,
    programName: null,
    materialName: 'MDF',
    sheetImageUrl: null,
    sheetImageContentType: null,
    sheetImageSizeBytes: null,
    parseStatus: 'parsed',
    completionStatus: 'pending',
    thumbsUp: false,
    completedAt: null,
    rework: false,
    comments: [],
    tools: [],
    dowelingLinks: [],
    analysisWarnings: [],
    ocrEngine: null,
    parserVersion: 'test',
    cutLayout: null,
    itemCount: items.length,
    itemQuantityTotal: items.reduce((sum, item) => sum + item.quantity, 0),
    updatedAt: '2026-07-19T00:00:00.000Z',
    items,
    ...overrides,
  };
}

function cncPacketItem(
  packetItemId: string,
  overrides: Partial<CncTelegramPacket['items'][number]> = {},
): CncTelegramPacket['items'][number] {
  return {
    packetItemId,
    sourceItemKey: packetItemId,
    orderName: '2706',
    orderId: 2706,
    detailNumber: 1,
    widthMm: 450,
    heightMm: 300,
    quantity: 1,
    source: 'manual',
    confidence: 1,
    matchOrderId: 2706,
    matchDetailId: 1,
    matchStatus: 'matched',
    reviewNote: null,
    ...overrides,
  };
}

function cncBath(
  bathCardId: string,
  orderNames: string[],
  overrides: Partial<CncTelegramBathCard> = {},
): CncTelegramBathCard {
  const items = orderNames.map((orderName, index) => ({
    bathItemId: `${bathCardId}-${index}`,
    orderId: Number(orderName) || index + 1,
    orderName,
    detailId: index + 1,
    detailNumber: index + 1,
    widthMm: null,
    heightMm: null,
    quantity: 1,
    completedQuantity: 1,
    ready: true,
  }));
  return {
    bathCardId,
    cutJobId: 1,
    cutResultId: 1,
    resultNo: 1,
    revisionNo: 1,
    cutNumber: bathCardId,
    cutJobName: bathCardId,
    createdAt: '2026-07-19T00:00:00.000Z',
    forced: false,
    ready: false,
    orderCount: orderNames.length,
    positionCount: items.length,
    itemQuantityTotal: items.reduce((sum, item) => sum + item.quantity, 0),
    items,
    sheets: [],
    ...overrides,
  };
}
