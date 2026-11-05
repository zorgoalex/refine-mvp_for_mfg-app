import type {
  CncTelegramBathCard,
  CncTelegramBazisCutSetCard,
  CncTelegramPacket,
  CncTelegramTodayColumn,
} from '../../api/types/cncTelegramApi.types';
import type {
  MdfPublishedCard,
  MdfPublishedCardPresentation,
  MdfPublishedSnapshot,
  MdfSourceKind,
} from '../../api/types/mdfPublishedApi.types';
import type { OrderStatusBoardCard } from '../../api/types/orderStatusBoardApi.types';
import { cncMaterialNameIsMdf, cncPacketCountsForMdfReadiness } from './cncDetailedMachine';
import { cncOrderDetailSourceKeys, indexCncOrderComposition } from './model';
import { withLegacyBathDuplicates } from './mdfBathDuplicates';
import type { CncBoardManualMoveState, CncOrderReadiness } from './OrderStatusBoardPage';

/**
 * Hybrid MDF board: the legacy screen on the engine's data (engine `active`/`read_only`).
 *
 * The engine decides which MDF cards exist (machine files of MDF, BASIS sets, baths), their column, order readiness,
 * issues and whether a card may be moved (its command token). The legacy `/cnc-telegram/today` read only supplies
 * the presentation of those cards — and is shown only when its same-snapshot digest equals the engine's accepted
 * digest, so the composition on screen is the one the command token acts on — plus non-MDF machine files whole.
 */

type ColumnKey = CncTelegramTodayColumn['key'];
export type MdfHybridCardSource = 'engine' | 'unregistered' | 'nonMdf';

export interface MdfHybridCardMeta {
  kind: MdfSourceKind;
  id: string;
  source: MdfHybridCardSource;
  /** The card's own placement before display overlays (hidden-card rules); a card shown elsewhere is not draggable. */
  column: ColumnKey;
  /** Engine cards only: the published command token (null ⇒ no command). */
  commandToken: string | null;
  /** Engine presentation shown instead of the legacy one (no binding or a different revision). */
  minimal: boolean;
  issues: string[];
  pending: boolean;
  movable: boolean;
  /** Why a drag is not offered (Russian, for the card tooltip). */
  blockedReason: string | null;
}

export interface MdfHybridBoard {
  columns: CncTelegramTodayColumn[];
  meta: ReadonlyMap<string, MdfHybridCardMeta>;
  /** Engine baths without a legacy card (search, focus, old cards): their «Разобрать дубль» facts are read apart. */
  engineOnlyBathIds: string[];
}

export const MDF_HYBRID_COLUMN_ORDER: readonly ColumnKey[] = ['parsed', 'completed', 'baths', 'baths_ready',
  'completed_laminated', 'baths_laminated', 'completed_baths'];

export const mdfHybridCardKey = (kind: MdfSourceKind, id: string): string => `${kind}:${id}`;

const READ_ONLY_REASON = 'Производственный учёт МДФ сейчас только для чтения';
const MINIMAL_REASON = 'Состав карточки обновляется — обновите доску';
const NO_TOKEN_REASON = 'Перенос недоступен: карточка требует проверки или нет доступа ко всем её заказам';
const UNPLACED_REASON = 'Карточка требует проверки';
const UNREGISTERED_REASON = 'Файл ещё не учтён в производственном учёте';

export function buildMdfHybridBoard(input: {
  legacyColumns: readonly CncTelegramTodayColumn[];
  snapshot: MdfPublishedSnapshot;
  /** Searched orders: their unregistered files outside the legacy period still appear (minimal, read-only). */
  searchOrderIds?: readonly number[];
}): MdfHybridBoard {
  const { snapshot } = input;
  const readOnly = snapshot.mode === 'read_only';
  const cards = new Map(snapshot.cards.map(card => [mdfHybridCardKey(card.kind, card.id), card]));
  const presentation = new Map(snapshot.presentation.map(p => [mdfHybridCardKey(p.kind, p.id), p]));
  const pending = new Set([...snapshot.pendingJobs, ...snapshot.trackedJobs]
    .filter(job => job.status === 'pending' && job.kind !== 'order' && job.kind !== 'orderDetail')
    .map(job => mdfHybridCardKey(job.kind as MdfSourceKind, job.id)));
  const unregistered = new Set(snapshot.unregistered.map(s => mdfHybridCardKey(s.kind, s.id)));
  const out = new Map<ColumnKey, { packets: CncTelegramPacket[]; baths: CncTelegramBathCard[];
    bazisCutSets: CncTelegramBazisCutSetCard[] }>(MDF_HYBRID_COLUMN_ORDER.map(key => [key,
    { packets: [], baths: [], bazisCutSets: [] }]));
  const meta = new Map<string, MdfHybridCardMeta>();
  const seen = new Set<string>();

  const engineMeta = (card: MdfPublishedCard, minimal: boolean): MdfHybridCardMeta => {
    const column = (card.column ?? (card.kind === 'bath' ? 'baths' : 'parsed')) as ColumnKey;
    const blockedReason = readOnly ? READ_ONLY_REASON : card.column === null ? UNPLACED_REASON
      : minimal ? MINIMAL_REASON : !card.commandToken ? NO_TOKEN_REASON : null;
    return { kind: card.kind, id: card.id, source: 'engine', column, commandToken: card.commandToken ?? null, minimal,
      issues: card.issues, pending: pending.has(mdfHybridCardKey(card.kind, card.id)), movable: blockedReason === null,
      blockedReason };
  };
  const place = (key: string, m: MdfHybridCardMeta, card: CncTelegramPacket | CncTelegramBathCard | CncTelegramBazisCutSetCard) => {
    seen.add(key);
    meta.set(key, m);
    const column = out.get(m.column)!;
    if (m.kind === 'packet') column.packets.push(card as CncTelegramPacket);
    else if (m.kind === 'bath') column.baths.push(card as CncTelegramBathCard);
    else column.bazisCutSets.push(card as CncTelegramBazisCutSetCard);
  };
  const bound = (key: string, legacyDigest: string | null | undefined): boolean => {
    const p = presentation.get(key);
    return Boolean(p && !p.stale && p.acceptedDigest && legacyDigest && legacyDigest === p.acceptedDigest);
  };

  for (const column of input.legacyColumns) {
    for (const packet of column.packets) {
      const key = mdfHybridCardKey('packet', packet.packetId);
      if (seen.has(key)) continue;
      const card = cards.get(key);
      if (card) {
        const isBound = bound(key, packet.mdfPresentationDigest);
        place(key, engineMeta(card, !isBound),
          isBound ? publishedPacketRows(packet, card, snapshot) : minimalPacket(card, presentation.get(key), snapshot));
      } else if (unregistered.has(key)) {
        place(key, unregisteredMeta('packet', packet.packetId, 'parsed'), packet);
      } else if (!cncPacketCountsForMdfReadiness(packet)) {
        // Outside the engine: legacy placement (the board projects its manual moves), never in MDF readiness.
        place(key, { kind: 'packet', id: packet.packetId, source: 'nonMdf', column: column.key, commandToken: null,
          minimal: false, issues: [], pending: false, movable: !readOnly, blockedReason: readOnly ? READ_ONLY_REASON : null },
        packet);
      }
      // An MDF file the engine did not select (window, hidden, no visible owner) is not shown.
    }
    for (const set of column.bazisCutSets ?? []) {
      const key = mdfHybridCardKey('bazisCutSet', String(set.bazisCutSetId));
      if (seen.has(key)) continue;
      const card = cards.get(key);
      if (card) {
        const isBound = bound(key, set.mdfPresentationDigest);
        place(key, engineMeta(card, !isBound),
          isBound ? publishedBazisRows(set, card, snapshot) : minimalBazisSet(card, presentation.get(key), snapshot));
      } else if (unregistered.has(key)) {
        place(key, unregisteredMeta('bazisCutSet', String(set.bazisCutSetId), 'parsed'), set);
      } else if (!set.items.some((item) => cncMaterialNameIsMdf(item.materialName))) {
        // A set with no MDF detail (e.g. ХДФ only) is outside the engine: shown where the legacy board places it, never
        // in MDF readiness, moved forward by hand through the non-MDF command (as a non-MDF machine file).
        place(key, { kind: 'bazisCutSet', id: String(set.bazisCutSetId), source: 'nonMdf', column: column.key,
          commandToken: null, minimal: false, issues: [], pending: false, movable: !readOnly,
          blockedReason: readOnly ? READ_ONLY_REASON : null }, set);
      }
    }
    for (const bath of column.baths) {
      const key = mdfHybridCardKey('bath', bath.bathCardId);
      if (seen.has(key)) continue;
      const card = cards.get(key);
      if (!card) continue; // Baths are always MDF and registered by the baseline: the engine decides.
      const isBound = bound(key, bath.mdfPresentationDigest);
      // «Разобрать дубль»: the pair facts of the legacy read reach the card in both presentations (same cut-result id).
      place(key, engineMeta(card, !isBound), withLegacyBathDuplicates(
        withEngineBathCoverage(isBound ? publishedBathRows(bath, card, snapshot) : minimalBath(card, presentation.get(key), snapshot),
          card, snapshot), bath));
    }
  }
  // Engine cards the legacy read did not return (window/filters differ): minimal engine presentation.
  const engineOnlyBathIds: string[] = [];
  for (const card of snapshot.cards) {
    const key = mdfHybridCardKey(card.kind, card.id);
    if (seen.has(key)) continue;
    if (card.kind === 'bath') engineOnlyBathIds.push(card.id);
    const p = presentation.get(key);
    const minimal = card.kind === 'packet' ? minimalPacket(card, p, snapshot)
      : card.kind === 'bath' ? withEngineBathCoverage(minimalBath(card, p, snapshot), card, snapshot)
        : minimalBazisSet(card, p, snapshot);
    place(key, engineMeta(card, true), minimal);
  }
  // A searched order's unregistered file outside the legacy period: an informational card from the snapshot only.
  const searched = new Set(input.searchOrderIds ?? []);
  for (const source of searched.size ? snapshot.unregistered : []) {
    const key = mdfHybridCardKey(source.kind, source.id);
    if (seen.has(key) || !source.orderIds.some(id => searched.has(id))) continue;
    place(key, unregisteredMeta(source.kind, source.id, 'parsed'), unregisteredCard(source, snapshot));
  }

  return {
    meta,
    engineOnlyBathIds,
    columns: MDF_HYBRID_COLUMN_ORDER.map(key => {
      const column = out.get(key)!;
      // The board re-titles columns by key when it projects them (`cncColumnTitleByKey`).
      const title = input.legacyColumns.find(c => c.key === key)?.title ?? '';
      return { key, title, total: column.packets.length + column.baths.length + column.bazisCutSets.length, ...column };
    }),
  };
}

function unregisteredMeta(kind: MdfSourceKind, id: string, column: ColumnKey): MdfHybridCardMeta {
  return { kind, id, source: 'unregistered', column, commandToken: null, minimal: false, issues: [], pending: false,
    movable: false, blockedReason: UNREGISTERED_REASON };
}

/** Manual moves the hybrid board still projects client-side: non-MDF machine files only. The engine's column is
 * already final for its cards, and order-card moves are status changes under the engine. */
export function mdfHybridManualMoves(manualMoves: CncBoardManualMoveState,
  meta: ReadonlyMap<string, MdfHybridCardMeta>): CncBoardManualMoveState {
  const result: CncBoardManualMoveState = {};
  for (const [key, value] of Object.entries(manualMoves)) {
    if (meta.get(key)?.source === 'nonMdf') result[key] = value;
  }
  return result;
}

function unregisteredCard(source: MdfPublishedSnapshot['unregistered'][number],
  snapshot: MdfPublishedSnapshot): CncTelegramPacket | CncTelegramBazisCutSetCard {
  const card: MdfPublishedCard = { kind: source.kind, id: source.id, displayName: source.displayName, column: null,
    sourceCreatedAt: source.sourceCreatedAt, acceptedRevision: null, receivedRevision: '', commandToken: null, issues: [] };
  if (source.kind === 'bazisCutSet') {
    return { ...minimalBazisSet(card, undefined, snapshot), items: source.orderIds.map(orderId => ({ orderId,
      orderName: orderName(snapshot, orderId), orderDeleted: false, detailId: null, detailNumber: null, widthMm: null,
      heightMm: null, materialName: '', quantity: 0, packedOrLater: false })) };
  }
  const minimal = minimalPacket(card, undefined, snapshot);
  const items = source.orderIds.map((orderId, index) => ({ packetItemId: `${source.id}:${index}`, sourceItemKey: String(index),
    orderName: orderName(snapshot, orderId), orderId, detailNumber: null, widthMm: null, heightMm: null, quantity: 0,
    source: 'manual' as const, confidence: 1, matchOrderId: orderId, matchDetailId: null, matchDetailQuantity: null,
    matchStatus: 'matched' as const, reviewNote: null, laminatedOrLater: false }));
  return { ...minimal, items, itemCount: items.length, itemQuantityTotal: 0 };
}

const membersOf = (snapshot: MdfPublishedSnapshot, card: MdfPublishedCard) =>
  snapshot.members.filter(m => m.kind === card.kind && m.id === card.id);
const memberKeys = (snapshot: MdfPublishedSnapshot, card: MdfPublishedCard) =>
  new Set(membersOf(snapshot, card).map(m => `${m.orderId}:${m.detailId}`));

/* A bound legacy card shows only the MDF positions the engine published for it: a detached position (raw row kept,
 * membership gone) and rows of orders the viewer may not see are not operational content. Unmatched rows and non-MDF
 * rows of a BASIS set stay as today — they never were members. Totals follow the shown rows. */
function publishedPacketRows(packet: CncTelegramPacket, card: MdfPublishedCard, snapshot: MdfPublishedSnapshot): CncTelegramPacket {
  const keys = memberKeys(snapshot, card);
  const items = packet.items.filter(item => item.matchOrderId === null || item.matchDetailId === null
    || keys.has(`${item.matchOrderId}:${item.matchDetailId}`));
  if (items.length === packet.items.length) return packet;
  return { ...packet, items, itemCount: items.length, itemQuantityTotal: items.reduce((sum, item) => sum + item.quantity, 0) };
}

function publishedBazisRows(set: CncTelegramBazisCutSetCard, card: MdfPublishedCard,
  snapshot: MdfPublishedSnapshot): CncTelegramBazisCutSetCard {
  const keys = memberKeys(snapshot, card);
  const items = set.items.filter(item => item.orderId === null || item.detailId === null
    || !cncMaterialNameIsMdf(item.materialName) || keys.has(`${item.orderId}:${item.detailId}`));
  if (items.length === set.items.length) return set;
  return { ...set, items, orderCount: new Set(items.map(i => i.orderId)).size, positionCount: items.length,
    itemQuantityTotal: items.reduce((sum, item) => sum + item.quantity, 0) };
}

function publishedBathRows(bath: CncTelegramBathCard, card: MdfPublishedCard, snapshot: MdfPublishedSnapshot): CncTelegramBathCard {
  const keys = memberKeys(snapshot, card);
  const items = bath.items.filter(item => keys.has(`${item.orderId}:${item.detailId}`));
  if (items.length === bath.items.length) return bath;
  return { ...bath, items, orderCount: new Set(items.map(i => i.orderId)).size, positionCount: items.length,
    itemQuantityTotal: items.reduce((sum, item) => sum + item.quantity, 0) };
}
const orderName = (snapshot: MdfPublishedSnapshot, orderId: number) =>
  snapshot.orders.find(o => o.orderId === orderId)?.orderName ?? `Заказ ${orderId}`;

function minimalPacket(card: MdfPublishedCard, p: MdfPublishedCardPresentation | undefined,
  snapshot: MdfPublishedSnapshot): CncTelegramPacket {
  const composition = p?.composition ?? null;
  const live = p?.live ?? null;
  const rows = composition?.items.length ? composition.items
    : membersOf(snapshot, card).map(m => ({ orderId: m.orderId, detailId: m.detailId, detailNumber: null,
      widthMm: null, heightMm: null, quantity: m.quantity }));
  const items = rows.map((row, index) => ({
    packetItemId: `${card.id}:${index}`, sourceItemKey: String(index), orderName: orderName(snapshot, row.orderId),
    orderId: row.orderId, detailNumber: typeof row.detailNumber === 'number' ? row.detailNumber : null,
    widthMm: row.widthMm, heightMm: row.heightMm, quantity: row.quantity, source: 'manual' as const, confidence: 1,
    matchOrderId: row.orderId, matchDetailId: row.detailId, matchDetailQuantity: null, matchStatus: 'matched' as const,
    reviewNote: null, laminatedOrLater: false,
  }));
  const comments = Array.isArray(live?.comments) ? live.comments.filter((c): c is string => typeof c === 'string') : [];
  return {
    packetId: card.id, externalPacketKey: composition?.externalKey ?? '', cuttingSequenceNo: composition?.cuttingSequenceNo ?? null,
    sourceChatId: '', sourceMessageId: null, sourceThreadId: null, sourceVersion: 0, sourceCreatedAt: card.sourceCreatedAt,
    sourceUpdatedAt: null, workday: card.sourceCreatedAt.slice(0, 10), machine: null,
    programName: composition?.programName ?? card.displayName, materialName: composition?.materialName ?? '',
    sheetImageUrl: null, sheetImageContentType: null, sheetImageSizeBytes: null, parseStatus: 'parsed',
    completionStatus: live?.completionStatus === 'completed' ? 'completed' : 'pending', thumbsUp: live?.thumbsUp === true,
    completedAt: null, rework: live?.rework === true, comments, tools: [], dowelingLinks: [], analysisWarnings: [],
    ocrEngine: null, parserVersion: '', cutLayout: null, allLinkedOrderDetailsPackedOrLater: false,
    allLinkedOrderDetailsIssuedOrLater: false, itemCount: items.length,
    itemQuantityTotal: items.reduce((sum, item) => sum + item.quantity, 0), updatedAt: snapshot.generatedAt, items,
  };
}

function minimalBazisSet(card: MdfPublishedCard, p: MdfPublishedCardPresentation | undefined,
  snapshot: MdfPublishedSnapshot): CncTelegramBazisCutSetCard {
  const rows = p?.composition?.items.length ? p.composition.items
    : membersOf(snapshot, card).map(m => ({ orderId: m.orderId, detailId: m.detailId, detailNumber: null,
      widthMm: null, heightMm: null, quantity: m.quantity }));
  const items = rows.map(row => ({ orderId: row.orderId, orderName: orderName(snapshot, row.orderId), orderDeleted: false,
    detailId: row.detailId, detailNumber: typeof row.detailNumber === 'number' ? row.detailNumber : null,
    widthMm: row.widthMm, heightMm: row.heightMm, materialName: '', quantity: row.quantity, packedOrLater: false }));
  return {
    bazisCutSetId: Number(card.id), name: p?.live?.name ?? card.displayName, createdAt: card.sourceCreatedAt,
    orderCount: new Set(items.map(i => i.orderId)).size, positionCount: items.length,
    itemQuantityTotal: items.reduce((sum, item) => sum + item.quantity, 0), items,
  };
}

function minimalBath(card: MdfPublishedCard, p: MdfPublishedCardPresentation | undefined,
  snapshot: MdfPublishedSnapshot): CncTelegramBathCard {
  const composition = p?.composition ?? null;
  const cutResultId = Number(card.id.replace(/^cut-result:/, ''));
  const items = membersOf(snapshot, card).map(m => ({ bathItemId: `${card.id}:${m.orderId}:${m.detailId}`,
    orderId: m.orderId, orderName: orderName(snapshot, m.orderId), detailId: m.detailId, detailNumber: null,
    widthMm: null, heightMm: null, quantity: m.quantity, completedQuantity: 0, ready: false,
    laminatedOrLater: false, packedOrLater: false }));
  return {
    bathCardId: card.id, cutJobId: composition?.cutJobId ?? 0, cutResultId, resultNo: composition?.resultNo ?? 0,
    revisionNo: composition?.revisionNo ?? 0, cutNumber: composition?.cutJobName ?? card.displayName,
    displayCutNumber: null, cutJobName: composition?.cutJobName ?? card.displayName, createdAt: card.sourceCreatedAt,
    ready: false, orderCount: new Set(items.map(i => i.orderId)).size, positionCount: items.length,
    itemQuantityTotal: items.reduce((sum, item) => sum + item.quantity, 0), items, sheets: [],
  };
}

/** Pieces of a bath: the engine's allocation coverage frozen with its publication, never the legacy count or the
 * bath's own (usually empty) cut proof. No published coverage ⇒ "no accounting data": no completed pieces. */
export function withEngineBathCoverage(bath: CncTelegramBathCard, card: MdfPublishedCard,
  snapshot: MdfPublishedSnapshot): CncTelegramBathCard {
  const progress = new Map(snapshot.progress.filter(p => p.kind === 'bath' && p.id === card.id)
    .map(p => [`${p.orderId}:${p.detailId}`, p]));
  return {
    ...bath,
    items: bath.items.map(item => {
      const row = progress.get(`${item.orderId}:${item.detailId}`);
      const allocated = typeof row?.allocated === 'number' ? row.allocated : null;
      const completedQuantity = allocated === null ? 0 : Math.min(item.quantity, Math.max(0, allocated));
      return { ...item, completedQuantity, ready: allocated !== null && completedQuantity >= item.quantity,
        coverageUnknown: allocated === null };
    }),
  };
}

/**
 * Order readiness with the engine's MDF facts. The legacy formula and denominator stay: only the MDF positions'
 * cut/rolled come from `snapshot.positions`, in legacy units (cut covers rolled pieces too; legacy subtracts rolled
 * again), and non-MDF positions keep their legacy contribution. The order board and the snapshot are separate reads:
 * unless the order's MDF details (backend `mdfEligible`) equal its published positions, readiness is unknown — the
 * order is never auto-placed as ready on arithmetic from two different compositions.
 */
export function buildMdfHybridOrderReadiness(input: {
  legacy: ReadonlyMap<number, CncOrderReadiness>;
  orderCards: readonly OrderStatusBoardCard[];
  snapshot: MdfPublishedSnapshot;
}): Map<number, CncOrderReadiness> {
  const positionsByOrder = new Map<number, MdfPublishedSnapshot['positions']>();
  for (const position of input.snapshot.positions) {
    const list = positionsByOrder.get(position.orderId) ?? [];
    list.push(position);
    positionsByOrder.set(position.orderId, list);
  }
  const result = new Map(input.legacy);
  for (const card of input.orderCards) {
    const legacy = input.legacy.get(card.orderId);
    const positions = positionsByOrder.get(card.orderId) ?? [];
    const details = card.details ?? [];
    if (details.some(d => d.mdfEligible === undefined)) {
      result.set(card.orderId, unknownReadiness(legacy));
      continue;
    }
    const mdfDetails = details.filter(d => d.mdfEligible === true);
    if (!mdfDetails.length && !positions.length) continue; // No MDF demand: the legacy result is unchanged.
    const demand = new Map<number, number>();
    for (const d of mdfDetails) demand.set(d.detailId, Math.max(0, Math.trunc(d.quantity)));
    const coherent = demand.size === positions.length
      && positions.every(p => demand.get(p.detailId) === p.required);
    if (!coherent) {
      result.set(card.orderId, unknownReadiness(legacy));
      continue;
    }
    const quantities = new Map(legacy?.positionQuantities ?? []);
    const { numberCounts } = indexCncOrderComposition(card);
    for (const detail of mdfDetails) {
      for (const key of cncOrderDetailSourceKeys(detail, numberCounts)) quantities.delete(key);
    }
    for (const p of positions) {
      quantities.set(`id:${p.detailId}`, { cut: p.creditedCut + p.creditedRolled, rolled: p.creditedRolled });
    }
    result.set(card.orderId, { ...(legacy ?? { totalDetails: 0, cutDetails: 0, rolledDetails: 0, remainingDetails: 0 }),
      positionQuantities: quantities });
  }
  return result;
}

function unknownReadiness(legacy: CncOrderReadiness | undefined): CncOrderReadiness {
  return { totalDetails: legacy?.totalDetails ?? 0, cutDetails: 0, rolledDetails: 0, remainingDetails: 0, unknown: true };
}

/** Orders with MDF demand that own no engine card of the snapshot: their positions are requested by id (at most 100,
 * the endpoint bound; the rest stay "unknown"). Derived from card membership, which the `orderIds` parameter does not
 * change — so requesting them never changes the answer (no refetch loop). */
export function mdfHybridMissingPositionOrderIds(orderCards: readonly OrderStatusBoardCard[],
  snapshot: MdfPublishedSnapshot | null): number[] {
  const owners = new Set(snapshot?.members.map(m => m.orderId) ?? []);
  return [...new Set(orderCards.filter(card => !owners.has(card.orderId)
    && (card.details ?? []).some(d => d.mdfEligible === true)).map(card => card.orderId))]
    .sort((a, b) => a - b).slice(0, 100);
}
