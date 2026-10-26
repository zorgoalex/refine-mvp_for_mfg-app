import { describe, expect, it } from 'vitest';
import type { CncTelegramBathCard, CncTelegramPacket, CncTelegramTodayColumn } from '../../api/types/cncTelegramApi.types';
import type { MdfPublishedCard, MdfPublishedSnapshot } from '../../api/types/mdfPublishedApi.types';
import type { OrderStatusBoardCard } from '../../api/types/orderStatusBoardApi.types';
import {
  buildMdfHybridBoard,
  buildMdfHybridOrderReadiness,
  mdfHybridManualMoves,
  mdfHybridMissingPositionOrderIds,
} from './mdfHybridBoard';
import { buildCncOrderReadiness, splitCncOrderCardsByManualColumn } from './OrderStatusBoardPage';

const TOKEN = 'a'.repeat(64);
const DIGEST = 'd'.repeat(64);

function packet(id: string, overrides: Partial<CncTelegramPacket> = {}): CncTelegramPacket {
  return {
    packetId: id, externalPacketKey: id, cuttingSequenceNo: null, sourceChatId: '', sourceMessageId: null,
    sourceThreadId: null, sourceVersion: 1, sourceCreatedAt: '2026-10-20T00:00:00Z', sourceUpdatedAt: null,
    workday: '2026-10-20', machine: null, programName: `E2E ${id}.nc`, materialName: 'МДФ 16 мм', sheetImageUrl: null,
    sheetImageContentType: null, sheetImageSizeBytes: null, parseStatus: 'parsed', completionStatus: 'pending',
    thumbsUp: false, completedAt: null, rework: false, comments: [], tools: [], dowelingLinks: [], analysisWarnings: [],
    ocrEngine: null, parserVersion: '1', cutLayout: null, allLinkedOrderDetailsPackedOrLater: false,
    allLinkedOrderDetailsIssuedOrLater: false, itemCount: 1, itemQuantityTotal: 4, updatedAt: '2026-10-20T00:00:00Z',
    mdfPresentationDigest: DIGEST,
    items: [{ packetItemId: `${id}-1`, sourceItemKey: '1', orderName: 'E2E-Тест 7', orderId: 7, detailNumber: 1,
      widthMm: 300, heightMm: 500, quantity: 4, source: 'vector', confidence: 1, matchOrderId: 7, matchDetailId: 70,
      matchDetailQuantity: 10, matchStatus: 'matched', reviewNote: null, laminatedOrLater: false }],
    ...overrides,
  };
}

function bath(id: string, overrides: Partial<CncTelegramBathCard> = {}): CncTelegramBathCard {
  return {
    bathCardId: id, cutJobId: 1, cutResultId: Number(id.split(':')[1]), resultNo: 1, revisionNo: 1, cutNumber: '1',
    cutJobName: 'E2E bath', createdAt: '2026-10-20T00:00:00Z', ready: true, orderCount: 1, positionCount: 1,
    itemQuantityTotal: 10, sheets: [{ cutGroupId: 1, sheetIndex: 0, sheetNumber: 1, variant: 'auto', sheetWidthMm: 2800,
      sheetHeightMm: 2070 }], mdfPresentationDigest: DIGEST,
    items: [{ bathItemId: `${id}-1`, orderId: 7, orderName: 'E2E-Тест 7', detailId: 70, detailNumber: 1, widthMm: 300,
      heightMm: 500, quantity: 10, completedQuantity: 10, ready: true, laminatedOrLater: false, packedOrLater: false }],
    ...overrides,
  };
}

function engineCard(kind: MdfPublishedCard['kind'], id: string, overrides: Partial<MdfPublishedCard> = {}): MdfPublishedCard {
  return { kind, id, displayName: `E2E ${id}`, column: kind === 'bath' ? 'baths_ready' : 'completed',
    sourceCreatedAt: '2026-10-20T00:00:00Z', acceptedRevision: 'r1', receivedRevision: 'r1', commandToken: TOKEN, issues: [],
    ...overrides };
}

function snapshot(overrides: Partial<MdfPublishedSnapshot> = {}): MdfPublishedSnapshot {
  return {
    schemaVersion: 1, mode: 'active', revision: '5', generatedAt: '2026-10-25T00:00:00Z', dateFrom: '2026-10-19',
    dateTo: '2026-10-25', cards: [], members: [], positions: [], pendingJobs: [], trackedJobs: [], presentation: [],
    progress: [], orders: [{ orderId: 7, orderName: 'E2E-Тест 7' }], unregistered: [], issues: [], ...overrides,
  };
}

const bound = (kind: MdfPublishedCard['kind'], id: string, acceptedDigest: string | null = DIGEST) =>
  ({ kind, id, stale: acceptedDigest === null, acceptedDigest, composition: acceptedDigest === null ? null : { items: [] },
    live: null });

const columns = (parsed: CncTelegramPacket[] = [], baths: CncTelegramBathCard[] = [],
  completed: CncTelegramPacket[] = []): CncTelegramTodayColumn[] => [
  { key: 'parsed', title: 'Станок', total: parsed.length, packets: parsed, baths: [], bazisCutSets: [] },
  { key: 'completed', title: 'Распилено', total: completed.length, packets: completed, baths: [], bazisCutSets: [] },
  { key: 'baths', title: 'Карты ванн', total: baths.length, packets: [], baths, bazisCutSets: [] },
];

const where = (board: ReturnType<typeof buildMdfHybridBoard>, id: string) =>
  board.columns.find(c => c.packets.some(p => p.packetId === id) || c.baths.some(b => b.bathCardId === id))?.key;

describe('hybrid MDF board: legacy screen on engine data', () => {
  it('engine decides column and movability; bound legacy presentation is kept', () => {
    const legacy = packet('p1');
    const board = buildMdfHybridBoard({ legacyColumns: columns([legacy]),
      snapshot: snapshot({ cards: [engineCard('packet', 'p1')], presentation: [bound('packet', 'p1')],
        members: [{ kind: 'packet', id: 'p1', orderId: 7, detailId: 70, quantity: 4 }] }) });
    expect(where(board, 'p1')).toBe('completed');
    expect(board.columns.find(c => c.key === 'completed')!.packets[0]).toBe(legacy);
    expect(board.meta.get('packet:p1')).toMatchObject({ source: 'engine', movable: true, minimal: false, commandToken: TOKEN });
  });

  it.each([
    ['another accepted revision', 'e'.repeat(64)],
    ['a newer legacy read', null],
  ])('a digest mismatch (%s) shows the minimal engine card and blocks the command', (_case, acceptedDigest) => {
    const legacy = packet('p1', acceptedDigest === null ? { mdfPresentationDigest: 'f'.repeat(64) } : {});
    const board = buildMdfHybridBoard({ legacyColumns: columns([legacy]), snapshot: snapshot({
      cards: [engineCard('packet', 'p1')], presentation: [bound('packet', 'p1', acceptedDigest ?? DIGEST)],
      members: [{ kind: 'packet', id: 'p1', orderId: 7, detailId: 70, quantity: 4 }] }) });
    const shown = board.columns.find(c => c.key === 'completed')!.packets[0];
    expect(shown).not.toBe(legacy);
    expect(shown.items).toEqual([expect.objectContaining({ matchOrderId: 7, matchDetailId: 70, quantity: 4 })]);
    expect(board.meta.get('packet:p1')).toMatchObject({ minimal: true, movable: false,
      blockedReason: expect.stringContaining('обновляется') });
  });

  it('a bound card shows only published positions: a detached position (raw row kept) is not operational content', () => {
    const legacy = packet('p1', { items: [...packet('p1').items, { ...packet('p1').items[0], packetItemId: 'p1-2',
      matchDetailId: 71, detailNumber: 2, quantity: 3 }, { ...packet('p1').items[0], packetItemId: 'p1-3',
      matchOrderId: null, matchDetailId: null, quantity: 1 }], itemCount: 3, itemQuantityTotal: 8 });
    const board = buildMdfHybridBoard({ legacyColumns: columns([legacy]), snapshot: snapshot({
      cards: [engineCard('packet', 'p1')], presentation: [bound('packet', 'p1')],
      members: [{ kind: 'packet', id: 'p1', orderId: 7, detailId: 70, quantity: 4 }] }) });
    const shown = board.columns.find(c => c.key === 'completed')!.packets[0];
    expect(shown.items.map(i => i.packetItemId)).toEqual(['p1-1', 'p1-3']);
    expect(shown).toMatchObject({ itemCount: 2, itemQuantityTotal: 5 });
    const bathBoard = buildMdfHybridBoard({ legacyColumns: columns([], [bath('cut-result:9', { items: [...bath('cut-result:9').items,
      { ...bath('cut-result:9').items[0], bathItemId: 'b-2', detailId: 71, quantity: 2 }] })]),
    snapshot: snapshot({ cards: [engineCard('bath', 'cut-result:9')], presentation: [bound('bath', 'cut-result:9')],
      members: [{ kind: 'bath', id: 'cut-result:9', orderId: 7, detailId: 70, quantity: 10 }] }) });
    expect(bathBoard.columns.find(c => c.key === 'baths_ready')!.baths[0]).toMatchObject({ positionCount: 1, itemQuantityTotal: 10 });
  });

  it('a stale presentation or a legacy card without digest (older backend) is never bound', () => {
    for (const legacy of [packet('p1'), packet('p1', { mdfPresentationDigest: undefined })]) {
      const board = buildMdfHybridBoard({ legacyColumns: columns([legacy]), snapshot: snapshot({
        cards: [engineCard('packet', 'p1')],
        presentation: [legacy.mdfPresentationDigest ? bound('packet', 'p1', null) : bound('packet', 'p1')] }) });
      expect(board.meta.get('packet:p1')).toMatchObject({ minimal: true, movable: false });
    }
  });

  it('an unplaced engine card sits in its first stage and needs a check; engine-only cards render minimal', () => {
    const board = buildMdfHybridBoard({ legacyColumns: columns(), snapshot: snapshot({
      cards: [engineCard('packet', 'p1', { column: null, commandToken: null, issues: ['MEMBERSHIP_MISSING'] }),
        engineCard('bath', 'cut-result:9', { column: 'baths' })],
      members: [{ kind: 'bath', id: 'cut-result:9', orderId: 7, detailId: 70, quantity: 10 }] }) });
    expect(where(board, 'p1')).toBe('parsed');
    expect(board.meta.get('packet:p1')).toMatchObject({ movable: false, blockedReason: 'Карточка требует проверки' });
    expect(where(board, 'cut-result:9')).toBe('baths');
    expect(board.meta.get('bath:cut-result:9')).toMatchObject({ minimal: true, movable: false });
  });

  it('legacy MDF card: unregistered ⇒ shown, not movable, outside readiness; not selected by the engine ⇒ hidden', () => {
    const board = buildMdfHybridBoard({ legacyColumns: columns([packet('p1'), packet('p2')], [bath('cut-result:5')]),
      snapshot: snapshot({ unregistered: [{ kind: 'packet', id: 'p1', displayName: 'p1', sourceCreatedAt: '', orderIds: [7] }] }) });
    expect(where(board, 'p1')).toBe('parsed');
    expect(board.meta.get('packet:p1')).toMatchObject({ source: 'unregistered', movable: false });
    expect(where(board, 'p2')).toBeUndefined();
    expect(where(board, 'cut-result:5')).toBeUndefined();
  });

  it('a searched order\'s unregistered file outside the legacy period appears as an informational card', () => {
    const snap = snapshot({ unregistered: [{ kind: 'packet', id: 'u-old', displayName: 'E2E old.nc', sourceCreatedAt: '2026-09-01',
      orderIds: [7] }, { kind: 'packet', id: 'u-other', displayName: 'E2E other.nc', sourceCreatedAt: '2026-09-01', orderIds: [8] }] });
    const board = buildMdfHybridBoard({ legacyColumns: columns(), snapshot: snap, searchOrderIds: [7] });
    expect(where(board, 'u-old')).toBe('parsed');
    expect(board.meta.get('packet:u-old')).toMatchObject({ source: 'unregistered', movable: false });
    expect(board.columns.find(c => c.key === 'parsed')!.packets[0]).toMatchObject({ programName: 'E2E old.nc',
      items: [expect.objectContaining({ matchOrderId: 7, orderName: 'E2E-Тест 7' })] });
    expect(where(board, 'u-other')).toBeUndefined();
    expect(where(buildMdfHybridBoard({ legacyColumns: columns(), snapshot: snap }), 'u-old')).toBeUndefined();
  });

  it('a terminal legacy card the engine does not know is not shown (absence never proves history)', () => {
    const terminal: CncTelegramTodayColumn[] = [
      { key: 'completed_laminated', title: 'Готово', total: 1, packets: [packet('old')], baths: [], bazisCutSets: [] }];
    expect(where(buildMdfHybridBoard({ legacyColumns: terminal, snapshot: snapshot() }), 'old')).toBeUndefined();
  });

  it('non-MDF machine files keep their legacy column and their own manual moves only', () => {
    const hdf = packet('h1', { materialName: 'ХДФ 3 мм' });
    const board = buildMdfHybridBoard({ legacyColumns: columns([], [], [hdf]),
      snapshot: snapshot({ cards: [engineCard('packet', 'p1')], presentation: [bound('packet', 'p1')] }) });
    expect(where(board, 'h1')).toBe('completed');
    expect(board.meta.get('packet:h1')).toMatchObject({ source: 'nonMdf', movable: true });
    expect(mdfHybridManualMoves({ 'packet:h1': 'completed_laminated', 'packet:p1': 'parsed', 'order:7': 'orders_ready',
      'bath:cut-result:9': 'baths_ready' }, board.meta)).toEqual({ 'packet:h1': 'completed_laminated' });
  });

  it('a BASIS set without MDF details (ХДФ only) stays in its legacy column, not movable, outside readiness', () => {
    const set = (id: number, materials: string[]) => ({ bazisCutSetId: id, name: `БР-${id}`,
      items: materials.map((materialName, index) => ({ orderId: 3057, orderName: '3057', detailId: index + 1,
        detailNumber: index + 1, quantity: 1, materialName })) }) as unknown as CncTelegramBazisCutSetCard;
    const legacy = columns();
    legacy[0].bazisCutSets = [set(80, ['ХДФ 2800*2070 3мм черновой', 'ХДФ 3мм']), set(81, ['МДФ 16мм', 'ХДФ 3мм'])];
    const board = buildMdfHybridBoard({ legacyColumns: legacy, snapshot: snapshot() });
    const parsed = board.columns.find(c => c.key === 'parsed')!;
    expect(parsed.bazisCutSets.map(s => s.bazisCutSetId)).toEqual([80]);
    expect(board.meta.get('bazisCutSet:80')).toMatchObject({ source: 'nonMdf', movable: false });
    // A set with an MDF detail the engine did not select is still hidden: the engine decides MDF cards.
    expect(board.meta.has('bazisCutSet:81')).toBe(false);
  });

  it('read_only blocks every move; pending jobs mark the card', () => {
    const board = buildMdfHybridBoard({ legacyColumns: columns([packet('p1'), packet('h1', { materialName: 'ЛДСП' })]),
      snapshot: snapshot({ mode: 'read_only', cards: [engineCard('packet', 'p1')], presentation: [bound('packet', 'p1')],
        pendingJobs: [{ jobId: 'j', kind: 'packet', id: 'p1', status: 'pending', code: null, attempts: 0, orderIds: [7] }] }) });
    expect(board.meta.get('packet:p1')).toMatchObject({ movable: false, pending: true });
    expect(board.meta.get('packet:h1')).toMatchObject({ movable: false });
  });

  it('bath pieces come from the frozen allocation coverage, never from the legacy count', () => {
    const progress = (allocated: number | null | undefined) => [{ kind: 'bath', id: 'cut-result:9', orderId: 7,
      detailId: 70, member: 10, cut: 0, laminated: 0, ...(allocated === undefined ? {} : { allocated }) }];
    const read = (allocated: number | null | undefined) => buildMdfHybridBoard({ legacyColumns: columns([], [bath('cut-result:9')]),
      snapshot: snapshot({ cards: [engineCard('bath', 'cut-result:9')], presentation: [bound('bath', 'cut-result:9')],
        members: [{ kind: 'bath', id: 'cut-result:9', orderId: 7, detailId: 70, quantity: 10 }],
        progress: progress(allocated) }) }).columns.find(c => c.key === 'baths_ready')!.baths[0].items[0];
    expect(read(10)).toMatchObject({ completedQuantity: 10, ready: true, coverageUnknown: false });
    expect(read(0)).toMatchObject({ completedQuantity: 0, ready: false, coverageUnknown: false });
    expect(read(4)).toMatchObject({ completedQuantity: 4, ready: false, coverageUnknown: false });
    // Legacy says 10/10 ready; the engine has no published coverage ⇒ "no accounting data", not a verified zero.
    expect(read(null)).toMatchObject({ completedQuantity: 0, ready: false, coverageUnknown: true });
    expect(read(undefined)).toMatchObject({ completedQuantity: 0, ready: false, coverageUnknown: true });
  });
});

describe('hybrid MDF board: order readiness from engine positions', () => {
  const order = (details: Array<{ detailId: number; quantity: number; mdfEligible?: boolean }>): OrderStatusBoardCard => ({
    orderId: 7, orderName: 'E2E-Тест 7', fullNumber: 'A-7', clientId: 1, clientName: null, priority: 100,
    plannedCompletionDate: null, pastPlannedDate: false, orderStatusId: 1, orderStatusName: 'Новый',
    orderStatusIssuedOrLater: false, productionStatusId: null, productionStatusName: null,
    productionStatusFromDetailsEnabled: true, paymentStatusId: null, paymentStatusName: null, finalAmount: null,
    paidAmount: null, debtAmount: null, partsCount: details.reduce((s, d) => s + d.quantity, 0), totalArea: 0,
    details: details.map((d, i) => ({ detailId: d.detailId, detailNumber: i + 1, quantity: d.quantity, bazisCutQuantity: 0,
      ...(d.mdfEligible === undefined ? {} : { mdfEligible: d.mdfEligible }) })),
    managerId: null, managerName: null, updatedAt: '2026-10-25T00:00:00Z', version: 1,
  } as OrderStatusBoardCard);
  const position = (detailId: number, required: number, creditedCut: number, creditedRolled: number) => ({
    orderId: 7, detailId, required, cut: creditedCut + creditedRolled, rolled: creditedRolled, creditedCut, creditedRolled,
    remaining: Math.max(0, required - creditedCut - creditedRolled), issues: [] });
  const placed = (card: OrderStatusBoardCard, positions: MdfPublishedSnapshot['positions']) => {
    const readiness = buildMdfHybridOrderReadiness({ legacy: buildCncOrderReadiness([], {}), orderCards: [card],
      snapshot: snapshot({ positions }) });
    const split = splitCncOrderCardsByManualColumn([card], readiness, {});
    const column = split.orders_ready.length ? 'orders_ready' : 'orders';
    return { column, readiness: [...split.orders, ...split.orders_ready][0].readiness };
  };

  it('uses legacy units: a fully covered, partly rolled position is ready (rolled is not subtracted twice)', () => {
    const result = placed(order([{ detailId: 70, quantity: 10, mdfEligible: true }]), [position(70, 10, 4, 6)]);
    expect(result.column).toBe('orders_ready');
    expect(result.readiness).toMatchObject({ remainingDetails: 0, creditedQuantities: { cut: 4, rolled: 6 } });
  });

  it('a mixed order stays unready while its non-MDF pieces are open', () => {
    const result = placed(order([{ detailId: 70, quantity: 10, mdfEligible: true }, { detailId: 71, quantity: 5, mdfEligible: false }]),
      [position(70, 10, 10, 0)]);
    expect(result.column).toBe('orders');
    expect(result.readiness).toMatchObject({ totalDetails: 15, remainingDetails: 5 });
  });

  it.each([
    ['quantity raised 10→12 after the engine read', [{ detailId: 70, quantity: 12, mdfEligible: true }], [position(70, 10, 10, 0)]],
    ['engine already counts 12, order board still 10', [{ detailId: 70, quantity: 10, mdfEligible: true }], [position(70, 12, 10, 0)]],
    ['MDF detail added', [{ detailId: 70, quantity: 10, mdfEligible: true }, { detailId: 72, quantity: 1, mdfEligible: true }],
      [position(70, 10, 10, 0)]],
    ['material changed to chipboard, same id and quantity', [{ detailId: 70, quantity: 10, mdfEligible: false }],
      [position(70, 10, 10, 0)]],
    ['older backend without mdfEligible', [{ detailId: 70, quantity: 10 }], [position(70, 10, 10, 0)]],
  ])('%s ⇒ unknown readiness, never auto-ready', (_case, details, positions) => {
    const result = placed(order(details), positions);
    expect(result.column).toBe('orders');
    expect(result.readiness.unknown).toBe(true);
  });

  it('an order without MDF demand keeps its legacy readiness; positions are requested only for card-less MDF orders', () => {
    const plain = order([{ detailId: 80, quantity: 3, mdfEligible: false }]);
    expect(placed(plain, []).readiness.unknown).toBeUndefined();
    const mdf = order([{ detailId: 70, quantity: 10, mdfEligible: true }]);
    expect(mdfHybridMissingPositionOrderIds([mdf, plain], snapshot())).toEqual([7]);
    expect(mdfHybridMissingPositionOrderIds([mdf], snapshot({
      members: [{ kind: 'packet', id: 'p1', orderId: 7, detailId: 70, quantity: 4 }] }))).toEqual([]);
  });
});
