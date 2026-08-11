import { describe, expect, it } from 'vitest';
import type {
  CncTelegramBazisCutSetCard,
  CncTelegramPacket,
  CncTelegramTodayColumn,
} from '../../api/types/cncTelegramApi.types';
import type {
  OrderStatusBoardCard,
  OrderStatusBoardColumn,
  OrderStatusBoardResponse,
} from '../../api/types/orderStatusBoardApi.types';
import {
  applyCncManualMovesToColumns,
  buildCncMachineColumnCards,
  buildCncOrderReadiness,
  cncRelationStatePriority,
  cncManualMoveDestinations,
  cncManualMoveStorageKey,
  formatStatusBoardOrderNumber,
  isCncManualMoveAllowed,
  splitCncOrderCardsByManualColumn,
  sortCncRelationCards,
  type CncBoardManualMoveState,
  type CncRelationCardState,
} from './OrderStatusBoardPage';
import {
  buildCncOrderSearchDateRange,
  buildCncOrderFilterOptions,
  buildCncOrderMissingDetails,
  buildOrderStatusBoardDatasetKey,
  collectCncOrderIds,
  DEFAULT_MDF_ORDER_CARD_SORT,
  filterBoardColumns,
  filterCncBathColumnsByMachineOrderMatches,
  filterCncBathColumnsByOrderStatuses,
  filterCncOrderCardsByPlannedOrderDate,
  filterCncTodayColumnsByOrders,
  filterCncTodayColumnsByPlannedOrderDate,
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
  it('sorts CNC relation cards by active and related state before dimmed cards', () => {
    const cards: Array<{ id: string; state: CncRelationCardState }> = [
      { id: 'dimmed', state: 'dimmed' },
      { id: 'normal', state: 'normal' },
      { id: 'related', state: 'related' },
      { id: 'active', state: 'active' },
      { id: 'order-mentioned', state: 'order-mentioned' },
    ];

    expect(cards.map((card) => cncRelationStatePriority(card.state))).toEqual([3, 2, 1, 0, 1]);
    expect(sortCncRelationCards(cards, (card) => card.state).map((card) => card.id)).toEqual([
      'active',
      'related',
      'order-mentioned',
      'normal',
      'dimmed',
    ]);
  });

  it('sorts mixed machine-file column cards in one relation-prioritized stream', () => {
    const dimmedBazis = { bazisCutSetId: 100 } as CncTelegramBazisCutSetCard;
    const normalBazis = { bazisCutSetId: 101 } as CncTelegramBazisCutSetCard;
    const relatedPacket = { packetId: 'packet-related' } as CncTelegramPacket;

    const cards = buildCncMachineColumnCards(
      [dimmedBazis, normalBazis],
      [relatedPacket],
      (card) => (card.bazisCutSetId === 100 ? 'dimmed' : 'normal'),
      () => 'related',
      true,
    );

    expect(cards.map((card) => (
      card.kind === 'packet'
        ? `packet:${card.card.packetId}`
        : `bazis:${card.card.bazisCutSetId}`
    ))).toEqual(['packet:packet-related', 'bazis:101', 'bazis:100']);
  });

  it('formats MDF order card numbers safely when compact cards receive incomplete live data', () => {
    expect(formatStatusBoardOrderNumber({ orderId: 2707, orderName: ' 2707 ' })).toBe('2707');
    expect(formatStatusBoardOrderNumber({ orderId: 2708 })).toBe('2708');
    expect(
      formatStatusBoardOrderNumber({
        orderId: 2709,
        orderName: undefined,
      } as unknown as OrderStatusBoardCard),
    ).toBe('2709');
  });

  it('toggles a temporary standard-view override for only one compact MDF card', () => {
    const first = toggleCncCardStandardOverride(new Set(), 'packet:p-1');

    expect(first).toEqual(new Set(['packet:p-1']));
    expect(isCncCardSummaryOnly('compact', first, 'packet:p-1')).toBe(false);
    expect(isCncCardSummaryOnly('compact', first, 'bath:b-1')).toBe(true);
    expect(isCncCardSummaryOnly('minimal', first, 'packet:p-1')).toBe(true);
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
      isCncCardSummaryOnly('minimal', new Set(), 'bath:b-1', true),
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
        'board=production&q=ABC&mine=1&overdue=1&showDone=1&plannedFrom=2026-07-01&hideEmpty=1&sort=orderNumber&direction=desc',
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
      sortBy: 'orderNumber',
      sortOrder: 'desc',
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
      sortBy: 'orderNumber',
      sortOrder: 'desc',
    });
  });

  it('uses a saved per-board sort when URL has no explicit sorting', () => {
    const state = parseOrderStatusBoardViewState(
      new URLSearchParams('board=production'),
      {
        defaultSort: { sortBy: 'updatedAt', sortOrder: 'desc' },
      },
    );

    expect(state).toMatchObject({
      sortBy: 'updatedAt',
      sortOrder: 'desc',
    });
    expect(serializeOrderStatusBoardViewState(state).toString()).toContain(
      'sort=updatedAt&direction=desc',
    );
  });

  it('falls back safely from invalid hand-edited sort parameters', () => {
    const state = parseOrderStatusBoardViewState(
      new URLSearchParams('sort=client&direction=newest'),
    );

    expect(state).toMatchObject({ sortBy: 'priority', sortOrder: 'asc' });
    expect(serializeOrderStatusBoardViewState(state).toString()).toContain(
      'sort=priority&direction=asc',
    );
  });

  it('keeps CNC today as visual flow without changing status-board API type', () => {
    const disabled = parseOrderStatusBoardViewState(new URLSearchParams('flow=cnc'));
    const state = parseOrderStatusBoardViewState(
      new URLSearchParams('flow=cnc&date=2026-07-23&period=2w&order=2706&order=2712&plannedToday=1'),
      {
        cncTelegram: true,
      },
    );

    expect(disabled.view).toBe('order');
    expect(state.view).toBe('cnc_today');
    expect(state.cncWorkday).toBe('2026-07-23');
    expect(state.cncOrderSearchPeriod).toBe('2w');
    expect(state.cncOrderFilters).toEqual(['2706', '2712']);
    expect(state.cncPlannedTodayOnly).toBe(true);
    const serialized = serializeOrderStatusBoardViewState(state);
    expect(serialized.toString()).toContain('flow=cnc');
    expect(serialized.toString()).toContain('date=2026-07-23');
    expect(serialized.toString()).toContain('period=2w');
    expect(serialized.toString()).toContain('plannedToday=1');
    expect(serialized.getAll('order')).toEqual(['2706', '2712']);
    expect(toOrderStatusBoardQuery(state)).toMatchObject({ board: 'order' });

    const defaultPeriodState = parseOrderStatusBoardViewState(
      new URLSearchParams('flow=cnc&date=2026-07-23'),
      { cncTelegram: true },
    );
    expect(defaultPeriodState.cncOrderSearchPeriod).toBe('1w');

    const fixedMdfState = parseOrderStatusBoardViewState(
      new URLSearchParams('period=1m&order=2707'),
      { cncTelegram: true, fixedView: 'cnc_today' },
    );
    expect(fixedMdfState.view).toBe('cnc_today');
    expect(fixedMdfState.cncOrderSearchPeriod).toBe('1m');
    expect(fixedMdfState.cncOrderFilters).toEqual(['2707']);
  });

  it('keeps MDF dataset reloads tied only to server-side date range inputs', () => {
    const baseParams = new URLSearchParams('flow=cnc&date=2026-08-11&period=1w');
    const baseState = parseOrderStatusBoardViewState(baseParams, {
      cncTelegram: true,
    });
    const uiParams = new URLSearchParams(
      'flow=cnc&date=2026-08-11&period=1w&order=2707&plannedToday=1&hideEmpty=1&sort=plannedDate&direction=desc',
    );
    const uiState = parseOrderStatusBoardViewState(uiParams, {
      cncTelegram: true,
    });
    const nextDateParams = new URLSearchParams('flow=cnc&date=2026-08-12&period=1w');
    const nextDateState = parseOrderStatusBoardViewState(nextDateParams, {
      cncTelegram: true,
    });
    const nextPeriodParams = new URLSearchParams('flow=cnc&date=2026-08-11&period=2w');
    const nextPeriodState = parseOrderStatusBoardViewState(nextPeriodParams, {
      cncTelegram: true,
    });

    const baseKey = buildOrderStatusBoardDatasetKey(
      baseParams,
      baseState,
      '2026-08-11',
    );

    expect(buildOrderStatusBoardDatasetKey(uiParams, uiState, '2026-08-11')).toBe(
      baseKey,
    );
    expect(buildOrderStatusBoardDatasetKey(
      nextDateParams,
      nextDateState,
      '2026-08-11',
    )).not.toBe(baseKey);
    expect(buildOrderStatusBoardDatasetKey(
      nextPeriodParams,
      nextPeriodState,
      '2026-08-11',
    )).not.toBe(baseKey);

    const fixedMdfParams = new URLSearchParams('hideEmpty=1&plannedToday=1');
    const fixedMdfState = parseOrderStatusBoardViewState(fixedMdfParams, {
      cncTelegram: true,
      fixedView: 'cnc_today',
    });

    expect(buildOrderStatusBoardDatasetKey(
      fixedMdfParams,
      fixedMdfState,
      '2026-08-11',
    )).toBe('flow=cnc&date=2026-08-11&period=1w');
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

  it('filters MDF cards by orders planned for the given date', () => {
    const columns = [
      {
        key: 'parsed',
        title: 'Файлы на станке',
        total: 4,
        packets: [
          cncPacket('p-today', ['2706', '2707'], [2706, 2707]),
          cncPacket('p-name-fallback', ['A-2800']),
          cncPacket('p-other', ['2712'], [2712]),
        ],
        baths: [],
        bazisCutSets: [
          cncBazisCutSet(8, [
            { orderName: '2706', orderId: 2706, detailId: 8001 },
            { orderName: '9999', orderId: 9999, detailId: 8002 },
          ]),
        ],
      },
      {
        key: 'baths',
        title: 'Ванны',
        total: 3,
        packets: [],
        baths: [
          cncBath('b-today', ['2706'], [2706]),
          cncBath('b-name-fallback', ['A-2800'], [0]),
          cncBath('b-other', ['2712'], [2712]),
        ],
      },
    ] as CncTelegramTodayColumn[];
    const orderCards = [
      card(2706, { orderName: '2706', plannedCompletionDate: '2026-08-11' }),
      card(2800, {
        orderName: '2800',
        fullNumber: 'A-2800',
        plannedCompletionDate: '2026-08-11T12:00:00+05:00',
      }),
      card(2712, { orderName: '2712', plannedCompletionDate: '2026-08-12' }),
    ];

    const filteredColumns = filterCncTodayColumnsByPlannedOrderDate(
      columns,
      orderCards,
      '2026-08-11',
    );

    expect(filteredColumns[0]?.packets.map((packet) => packet.packetId)).toEqual([
      'p-today',
      'p-name-fallback',
    ]);
    expect(filteredColumns[0]?.bazisCutSets?.map((set) => set.bazisCutSetId)).toEqual([8]);
    expect(filteredColumns[0]?.total).toBe(3);
    expect(filteredColumns[1]?.baths.map((bath) => bath.bathCardId)).toEqual([
      'b-today',
      'b-name-fallback',
    ]);
    expect(filteredColumns[1]?.total).toBe(2);
    expect(
      filterCncOrderCardsByPlannedOrderDate(orderCards, '2026-08-11')
        .map((order) => order.orderId),
    ).toEqual([2706, 2800]);
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

  it('allows MDF manual moves only inside card-specific column groups', () => {
    expect(isCncManualMoveAllowed('packet', 'parsed')).toBe(true);
    expect(isCncManualMoveAllowed('packet', 'completed')).toBe(true);
    expect(isCncManualMoveAllowed('packet', 'completed_laminated')).toBe(true);
    expect(isCncManualMoveAllowed('packet', 'baths_laminated')).toBe(false);
    expect(isCncManualMoveAllowed('bazisCutSet', 'completed')).toBe(true);
    expect(isCncManualMoveAllowed('bazisCutSet', 'completed_laminated')).toBe(true);
    expect(isCncManualMoveAllowed('bath', 'baths')).toBe(true);
    expect(isCncManualMoveAllowed('bath', 'baths_ready')).toBe(true);
    expect(isCncManualMoveAllowed('bath', 'baths_laminated')).toBe(true);
    expect(isCncManualMoveAllowed('bath', 'completed_baths')).toBe(true);
    expect(isCncManualMoveAllowed('bath', 'orders_ready')).toBe(false);
    expect(isCncManualMoveAllowed('order', 'orders')).toBe(true);
    expect(isCncManualMoveAllowed('order', 'orders_ready')).toBe(true);
    expect(isCncManualMoveAllowed('order', 'orders_issued')).toBe(true);
    expect(isCncManualMoveAllowed('order', 'completed')).toBe(false);
    expect(cncManualMoveDestinations('packet', 'parsed').map(({ key }) => key)).toEqual([
      'completed',
      'completed_laminated',
    ]);
    expect(cncManualMoveDestinations('bazisCutSet', 'parsed').map(({ key }) => key)).toEqual([
      'completed',
      'completed_laminated',
    ]);
    expect(cncManualMoveDestinations('packet', 'completed_laminated').map(({ key }) => key)).toEqual([
      'parsed',
      'completed',
    ]);
    expect(cncManualMoveDestinations('bath', 'completed_baths').map(({ key }) => key)).toEqual([
      'baths',
      'baths_ready',
      'baths_laminated',
    ]);
  });

  it('applies MDF manual moves to packet, bath, and Basis cut set display columns', () => {
    const columns = [
      {
        key: 'parsed',
        title: 'Файлы на станке',
        total: 2,
        packets: [cncPacket('packet-pending', ['2706'], [2706])],
        baths: [],
        bazisCutSets: [cncBazisCutSet(9001, [
          { orderName: '2707', orderId: 2707, detailId: null },
        ])],
      },
      {
        key: 'baths_ready',
        title: 'Готовы к закатке',
        total: 1,
        packets: [],
        baths: [cncBath('bath-ready', ['3000'], [3000])],
        bazisCutSets: [],
      },
    ] as CncTelegramTodayColumn[];
    const manualMoves: CncBoardManualMoveState = {
      [cncManualMoveStorageKey('packet', 'packet-pending')]: 'completed_laminated',
      [cncManualMoveStorageKey('bazisCutSet', '9001')]: 'completed_laminated',
      [cncManualMoveStorageKey('bath', 'bath-ready')]: 'completed_baths',
    };

    const moved = applyCncManualMovesToColumns(columns, manualMoves);

    expect(moved.find((column) => column.key === 'parsed')?.packets).toEqual([]);
    expect(moved.find((column) => column.key === 'parsed')?.bazisCutSets).toEqual([]);
    expect(moved.find((column) => column.key === 'completed_laminated')?.packets.map((packet) => packet.packetId)).toEqual(['packet-pending']);
    expect(moved.find((column) => column.key === 'completed_laminated')?.bazisCutSets?.map((card) => card.bazisCutSetId)).toEqual([9001]);
    expect(moved.find((column) => column.key === 'baths_ready')?.baths).toEqual([]);
    expect(moved.find((column) => column.key === 'completed_baths')?.baths.map((bath) => bath.bathCardId)).toEqual(['bath-ready']);
  });

  it('hides MDF cards moved to terminal columns when terminal columns are disabled', () => {
    const columns = [
      {
        key: 'parsed',
        title: 'Файлы на станке',
        total: 2,
        packets: [cncPacket('packet-pending', ['2706'], [2706])],
        baths: [],
        bazisCutSets: [cncBazisCutSet(9001, [
          { orderName: '2707', orderId: 2707, detailId: 7001 },
        ])],
      },
      {
        key: 'baths_ready',
        title: 'Готовы к закатке',
        total: 1,
        packets: [],
        baths: [cncBath('bath-ready', ['2708'], [2708])],
        bazisCutSets: [],
      },
    ] as CncTelegramTodayColumn[];
    const manualMoves: CncBoardManualMoveState = {
      [cncManualMoveStorageKey('packet', 'packet-pending')]: 'completed_laminated',
      [cncManualMoveStorageKey('bazisCutSet', '9001')]: 'completed_laminated',
      [cncManualMoveStorageKey('bath', 'bath-ready')]: 'completed_baths',
    };

    const hiddenTerminal = applyCncManualMovesToColumns(columns, manualMoves, {
      includeTerminalManualMoves: false,
    });
    const readiness = buildCncOrderReadiness(columns, manualMoves);

    expect(hiddenTerminal.find((column) => column.key === 'parsed')?.packets).toEqual([]);
    expect(hiddenTerminal.find((column) => column.key === 'parsed')?.bazisCutSets).toEqual([]);
    expect(hiddenTerminal.find((column) => column.key === 'baths_ready')?.baths).toEqual([]);
    expect(hiddenTerminal.find((column) => column.key === 'completed_laminated')).toBeUndefined();
    expect(hiddenTerminal.find((column) => column.key === 'completed_baths')).toBeUndefined();
    expect(readiness.get(2706)?.cutDetails).toBe(1);
    expect(readiness.get(2707)?.cutDetails).toBe(1);
    expect(readiness.get(2708)?.rolledDetails).toBe(1);
  });

  it('derives MDF order readiness from completed packets and rolled baths', () => {
    const columns = [
      {
        key: 'parsed',
        title: 'Файлы на станке',
        total: 1,
        packets: [cncPacket('packet-pending', ['2706'], [2706])],
        baths: [],
      },
      {
        key: 'completed',
        title: 'Распилено',
        total: 1,
        packets: [cncPacket('packet-ready', ['2712'], [2712])],
        baths: [],
      },
      {
        key: 'baths_ready',
        title: 'Готовы к закатке',
        total: 1,
        packets: [],
        baths: [cncBath('bath-ready', ['3000'], [3000])],
      },
    ] as CncTelegramTodayColumn[];
    const manualMoves: CncBoardManualMoveState = {
      [cncManualMoveStorageKey('packet', 'packet-pending')]: 'completed',
      [cncManualMoveStorageKey('bath', 'bath-ready')]: 'baths_laminated',
    };

    const readiness = buildCncOrderReadiness(columns, manualMoves);

    expect(readiness.get(2706)).toEqual({
      totalDetails: 1,
      cutDetails: 1,
      rolledDetails: 0,
      remainingDetails: 0,
    });
    expect(readiness.get(2712)).toEqual({
      totalDetails: 1,
      cutDetails: 1,
      rolledDetails: 0,
      remainingDetails: 0,
    });
    expect(readiness.get(3000)).toEqual({
      totalDetails: 1,
      cutDetails: 0,
      rolledDetails: 1,
      remainingDetails: 0,
    });
  });

  it('deduplicates MDF order readiness between machine files and Basis-cut sets', () => {
    const packet = cncPacket('packet-ready', ['2705'], [2705], [2705], [101]);
    packet.items[0] = {
      ...packet.items[0],
      detailNumber: 1,
      quantity: 2,
    };
    const bazisCutSet = cncBazisCutSet(9001, [
      { orderName: '2705', orderId: 2705, detailId: 101 },
    ]);
    bazisCutSet.items[0] = {
      ...bazisCutSet.items[0],
      detailNumber: 1,
      quantity: 2,
    };
    const columns = [
      {
        key: 'completed',
        title: 'Распилено',
        total: 2,
        packets: [packet],
        baths: [],
        bazisCutSets: [bazisCutSet],
      },
    ] as CncTelegramTodayColumn[];

    const readiness = buildCncOrderReadiness(columns, {});

    expect(readiness.get(2705)).toEqual({
      totalDetails: 2,
      cutDetails: 2,
      rolledDetails: 0,
      remainingDetails: 0,
    });
  });

  it('counts only MDF machine files and Basis-cut details for MDF order cut readiness', () => {
    const mdfPacket = cncPacket('packet-mdf', ['2705'], [2705], [2705], [101]);
    mdfPacket.items[0] = { ...mdfPacket.items[0], quantity: 2 };
    const hdfPacket = cncPacket('packet-hdf', ['2706'], [2706], [2706], [102]);
    hdfPacket.materialName = 'ХДФ 3 мм';
    hdfPacket.items[0] = { ...hdfPacket.items[0], quantity: 3 };
    const unknownPacket = cncPacket('packet-unknown', ['2707'], [2707], [2707], [103]);
    unknownPacket.materialName = 'Не определён';
    const bazisCutSet = cncBazisCutSet(9002, [
      { orderName: '2708', orderId: 2708, detailId: 108, materialName: 'МДФ 16 мм' },
      { orderName: '2709', orderId: 2709, detailId: 109, materialName: 'ЛДСП 16 мм' },
      { orderName: '2710', orderId: 2710, detailId: 110, materialName: 'Фанера 12 мм' },
    ]);
    const columns = [
      {
        key: 'completed',
        title: 'Распилено',
        total: 4,
        packets: [mdfPacket, hdfPacket, unknownPacket],
        baths: [],
        bazisCutSets: [bazisCutSet],
      },
    ] as CncTelegramTodayColumn[];

    const readiness = buildCncOrderReadiness(columns, {});

    expect(readiness.get(2705)?.cutDetails).toBe(2);
    expect(readiness.get(2708)?.cutDetails).toBe(1);
    expect(readiness.has(2706)).toBe(false);
    expect(readiness.has(2707)).toBe(false);
    expect(readiness.has(2709)).toBe(false);
    expect(readiness.has(2710)).toBe(false);
  });

  it('does not inflate MDF cut readiness from bath completed quantities or rework files', () => {
    const packet = cncPacket('packet-2678', ['2678'], [2678], [2678], [267801]);
    packet.items[0] = { ...packet.items[0], quantity: 20 };
    const reworkPacket = cncPacket('packet-2678-rework', ['2678'], [2678], [2678], [267803]);
    reworkPacket.rework = true;
    reworkPacket.items[0] = { ...reworkPacket.items[0], quantity: 5 };
    const bazisCutSet = cncBazisCutSet(9003, [
      { orderName: '2678', orderId: 2678, detailId: 267802, materialName: 'МДФ 16 мм' },
    ]);
    bazisCutSet.items[0] = { ...bazisCutSet.items[0], quantity: 13 };
    const bath = cncBath('bath-2678', ['2678'], [2678]);
    bath.items[0] = { ...bath.items[0], quantity: 38, completedQuantity: 38 };
    const columns = [
      {
        key: 'completed',
        title: 'Распилено',
        total: 3,
        packets: [packet, reworkPacket],
        baths: [],
        bazisCutSets: [bazisCutSet],
      },
      {
        key: 'baths_ready',
        title: 'Готовы к закатке',
        total: 1,
        packets: [],
        baths: [bath],
        bazisCutSets: [],
      },
    ] as CncTelegramTodayColumn[];

    const readiness = buildCncOrderReadiness(columns, {});
    const split = splitCncOrderCardsByManualColumn(
      [{ ...card(2678), orderName: '2678', partsCount: 80 }],
      readiness,
      {},
    );

    expect(readiness.get(2678)?.cutDetails).toBe(33);
    expect(split.orders[0]?.readiness).toEqual({
      totalDetails: 80,
      cutDetails: 33,
      rolledDetails: 0,
      remainingDetails: 47,
    });
  });

  it('keeps MDF order readiness total at least the order detail count', () => {
    const split = splitCncOrderCardsByManualColumn(
      [{ ...card(501), partsCount: 50 }],
      new Map([
        [501, {
          totalDetails: 40,
          cutDetails: 25,
          rolledDetails: 15,
          remainingDetails: 0,
        }],
      ]),
      {},
    );

    expect(split.orders.map(({ card: item }) => item.orderId)).toEqual([501]);
    expect(split.orders[0]?.readiness).toEqual({
      totalDetails: 50,
      cutDetails: 25,
      rolledDetails: 15,
      remainingDetails: 10,
    });
    expect(split.orders_ready).toEqual([]);
  });

  it('caps MDF order readiness by the order detail count', () => {
    const split = splitCncOrderCardsByManualColumn(
      [{ ...card(2705), partsCount: 34 }],
      new Map([
        [2705, {
          totalDetails: 53,
          cutDetails: 53,
          rolledDetails: 0,
          remainingDetails: 0,
        }],
      ]),
      {},
    );

    expect(split.orders).toEqual([]);
    expect(split.orders_ready.map(({ card: item }) => item.orderId)).toEqual([2705]);
    expect(split.orders_ready[0]?.readiness).toEqual({
      totalDetails: 34,
      cutDetails: 34,
      rolledDetails: 0,
      remainingDetails: 0,
    });
  });

  it('sorts MDF order cards by order number by default and supports selected direction', () => {
    const cards = [
      { ...card(10), orderName: '10', updatedAt: '2026-07-19T09:00:00.000Z' },
      { ...card(2), orderName: '2', updatedAt: '2026-07-19T11:00:00.000Z' },
      { ...card(1), orderName: '1', updatedAt: '2026-07-19T10:00:00.000Z' },
    ];

    const defaultSplit = splitCncOrderCardsByManualColumn(cards, new Map(), {});
    expect(DEFAULT_MDF_ORDER_CARD_SORT).toEqual({
      sortBy: 'orderNumber',
      sortOrder: 'asc',
    });
    expect(defaultSplit.orders.map(({ card: item }) => item.orderName)).toEqual([
      '1',
      '2',
      '10',
    ]);

    const updatedDescSplit = splitCncOrderCardsByManualColumn(cards, new Map(), {}, {
      sortBy: 'updatedAt',
      sortOrder: 'desc',
    });
    expect(updatedDescSplit.orders.map(({ card: item }) => item.orderName)).toEqual([
      '2',
      '1',
      '10',
    ]);
  });

  it('lists MDF order positions missing from machine files and Basis-cut sets', () => {
    const orderCard = {
      ...card(2705),
      details: [
        { detailId: 101, detailNumber: 1, quantity: 2, bazisCutQuantity: 0 },
        { detailId: 102, detailNumber: 2, quantity: 3, bazisCutQuantity: 0 },
        { detailId: 103, detailNumber: 3, quantity: 1, bazisCutQuantity: 1 },
        { detailId: 104, detailNumber: 4, quantity: 1, bazisCutQuantity: 0 },
      ],
    };
    const columns = [
      {
        key: 'completed',
        title: 'Распилено',
        total: 1,
        packets: [{
          ...cncPacket('p-2705', ['2705', '2705']),
          items: [
            {
              packetItemId: 'p-2705-1',
              orderName: '2705',
              orderId: 2705,
              matchOrderId: 2705,
              matchDetailId: 101,
              detailNumber: 1,
              quantity: 1,
            },
            {
              packetItemId: 'p-2705-2',
              orderName: '2705',
              orderId: null,
              matchOrderId: null,
              matchDetailId: null,
              detailNumber: 2,
              quantity: 1,
            },
          ],
        }],
        baths: [],
        bazisCutSets: [],
      },
    ] as CncTelegramTodayColumn[];

    const missing = buildCncOrderMissingDetails([orderCard], columns);

    expect(missing.get(2705)).toEqual([
      {
        detailId: 101,
        detailNumber: 1,
        requiredQuantity: 2,
        presentQuantity: 1,
        missingQuantity: 1,
      },
      {
        detailId: 102,
        detailNumber: 2,
        requiredQuantity: 3,
        presentQuantity: 1,
        missingQuantity: 2,
      },
      {
        detailId: 104,
        detailNumber: 4,
        requiredQuantity: 1,
        presentQuantity: 0,
        missingQuantity: 1,
      },
    ]);
  });

  it('keeps Basis-cut cards as machine-file cards even when bath details have packet files', () => {
    const columns = [
      {
        key: 'parsed',
        title: 'Файлы на станке',
        total: 3,
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

    const filtered = filterCncTodayColumnsByOrders(columns, ['2712']);

    expect(filtered[0]?.bazisCutSets?.map((card) => card.bazisCutSetId)).toEqual([9]);
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
        title: 'Закатаны',
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

function card(
  orderId: number,
  overrides: Partial<OrderStatusBoardCard> = {},
): OrderStatusBoardCard {
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
    details: [],
    managerId: null,
    managerName: null,
    updatedAt: '2026-07-19T00:00:00.000Z',
    version: 1,
    canChangeOrderStatus: false,
    canChangeProductionStatus: false,
    ...overrides,
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
    rework: false,
    items: orderNames.map((orderName, index) => ({
      packetItemId: `${packetId}-${index}`,
      orderName,
      orderId: orderIds[index] ?? null,
      matchOrderId: matchOrderIds[index] ?? null,
      matchDetailId: matchDetailIds[index] ?? null,
      quantity: 1,
      laminatedOrLater: false,
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
      quantity: 1,
      completedQuantity: 1,
      laminatedOrLater: false,
      packedOrLater: false,
    })),
  };
}

function cncBazisCutSet(
  bazisCutSetId: number,
  items: Array<{
    orderName: string;
    orderId: number | null;
    detailId: number | null;
    materialName?: string;
    packedOrLater?: boolean;
  }>,
) {
  return {
    bazisCutSetId,
    name: `БР-${bazisCutSetId}`,
    createdAt: '2026-08-01T08:00:00.000Z',
    orderCount: new Set(items.map((item) => item.orderId)).size,
    positionCount: items.length,
    itemQuantityTotal: items.length,
    items: items.map((item) => ({
      ...item,
      orderDeleted: false,
      detailNumber: null,
      widthMm: null,
      heightMm: null,
      materialName: item.materialName ?? 'МДФ 16 мм',
      quantity: 1,
      packedOrLater: item.packedOrLater ?? false,
    })),
  };
}
