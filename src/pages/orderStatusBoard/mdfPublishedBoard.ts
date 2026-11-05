import type {
  MdfPublishedCard,
  MdfPublishedCardPresentation,
  MdfPublishedOrderName,
  MdfPublishedSnapshot,
  MdfPublishedUnregisteredSource,
  MdfSourceColumn,
  MdfSourceKind,
} from '../../api/types/mdfPublishedApi.types';
import { parseMdfLiveComments } from './mdfBoardCommentLinks';

/** §5.6b/c: pure snapshot → board view-model adapter. The SET of cards, their column, issues,
 * command tokens, members and counters come only from the one loaded published snapshot; never
 * from legacy CNC data. Presentation (title, items, previews) is added from the snapshot's own
 * `presentation`/`progress`/`orders` sections, never from the unscoped legacy `today` payload. */

export interface MdfPublishedBoardItem {
  orderId: number;
  orderName: string | null;
  detailId: number | null;
  detailNumber: number | string | null;
  widthMm: number | null;
  heightMm: number | null;
  quantity: number;
  cut: number;
  laminated: number;
}

export interface MdfPublishedBoardMemberQuantity {
  orderId: number;
  orderName: string | null;
  detailId: number;
  quantity: number;
  /** This card's own progress for this (orderId, detailId) membership — independent of presentation. */
  cut: number;
  laminated: number;
}

/** §5.6 finding 8: whole-position (order+detail) accounting totals, read straight from
 * `snapshot.positions` — never summed across cards. Two cards sharing the same position show the
 * same totals (the single snapshot truth), not a doubled sum. */
export interface MdfPublishedBoardPositionTotal {
  orderId: number;
  orderName: string | null;
  detailId: number;
  required: number;
  creditedCut: number;
  creditedRolled: number;
  remaining: number;
}

export interface MdfPublishedBoardCard {
  kind: MdfSourceKind;
  id: string;
  column: MdfSourceColumn | null;
  sourceCreatedAt: string;
  title: string;
  orderIds: number[];
  orderNames: string[];
  /** True when the card is minimal: composition binding missing/mismatched, or presentation absent. */
  stale: boolean;
  staleNote: string | null;
  /** Composition items (visible orders only), aggregated to one row per (orderId, detailId); empty
   * when `stale` or when the composition carries no items (e.g. some bath presentations). */
  items: MdfPublishedBoardItem[];
  /** Always available (even when stale, even for bath cards without composition items): this
   * card's authorized membership (snapshot `members`), one row per (orderId, detailId), each with
   * this card's own progress (member/cut/laminated) — independent of presentation. */
  memberQuantities: MdfPublishedBoardMemberQuantity[];
  /** Whole-position totals (required/creditedCut/creditedRolled/remaining) for every (orderId,
   * detailId) this card has membership in — for a separate totals block/tooltip, never merged into
   * per-card progress. */
  positions: MdfPublishedBoardPositionTotal[];
  materialName: string | null;
  hasSheetImage: boolean;
  cutJobName: string | null;
  resultNo: number | null;
  rework: boolean;
  comments: string[];
  requiresAttention: boolean;
  issueTexts: string[];
  pendingNote: string | null;
  commandDisabledReason: string | null;
  commandToken: string | null;
}

export interface MdfPublishedUnregisteredCard {
  kind: 'packet' | 'bazisCutSet';
  id: string;
  displayName: string;
  sourceCreatedAt: string;
  orderNames: string[];
}

export const MDF_PUBLISHED_BOARD_COLUMNS: readonly { key: MdfSourceColumn; title: string }[] = [
  { key: 'parsed', title: 'Файлы на станке' },
  { key: 'completed', title: 'Распилено' },
  { key: 'completed_laminated', title: 'Распиленные файлы' },
  { key: 'baths', title: 'Карты ванн' },
  { key: 'baths_ready', title: 'Готовы к закатке' },
  { key: 'baths_laminated', title: 'Закатаны' },
  { key: 'completed_baths', title: 'Завершённые ванны' },
];

const MDF_BOARD_ISSUE_TEXT: Readonly<Record<string, string>> = {
  MDF_PARTIAL_ACCESS: 'Есть заказы, к которым у вас нет доступа',
  ACCEPTANCE_PENDING: 'Обрабатывается',
  MEMBER_OUTSIDE_LIVE_MDF_DEMAND: 'Состав карточки не совпадает с текущей потребностью заказа',
  MDF_DEMAND_CHANGED: 'Потребность заказа изменилась после регистрации карточки',
  LINEAGE_INVALID: 'Нарушена цепочка происхождения физического подтверждения',
  ALLOCATION_BASELINE_UNKNOWN: 'Не удалось определить базовый уровень распределения материала',
  MDF_ALLOCATION_UNVERIFIED: 'Распределение материала не подтверждено',
  PLACEMENT_UNKNOWN: 'Не удалось определить колонку карточки',
  MDF_PUBLICATION_PENDING: 'Обрабатывается',
  MDF_COMMAND_TOKEN_MISSING: 'Не удалось получить подтверждение карточки — обновите доску',
  MDF_ENGINE_NOT_ACTIVE: 'Производственный учёт не активен для согласованного чтения',
  MDF_READ_ONLY: 'Производственный учёт в режиме только чтения — перемещение недоступно',
  MDF_PUBLICATION_NOT_ACTIVE: 'Производственный учёт не активен для согласованного чтения',
  MDF_MOVE_PERMISSION_DENIED: 'Нет права менять производственные этапы',
};

/** Unknown code shown verbatim. */
export function mdfBoardIssueText(code: string): string {
  return MDF_BOARD_ISSUE_TEXT[code] ?? code;
}

const MDF_COMMAND_TOKEN_PATTERN = /^[a-f0-9]{64}$/;

/** Why this card's commands (drag/move/return) are disabled, or null when enabled. Mirrors the
 * readiness contract of `prepareMdfPublishedCommand`/`findReadyCard`, without executing anything.
 * §5.6 finding 9: `hasMoveGrant` is a literal permission check (does the current user's permissions
 * array include `production.tasks.update`?), evaluated by the caller and passed in — separate from,
 * and checked before, engine/card readiness, so a user without the grant always sees the permission
 * reason regardless of engine state. */
export function mdfPublishedCardCommandDisabledReason(
  snapshot: MdfPublishedSnapshot,
  card: MdfPublishedCard,
  hasMoveGrant: boolean,
): string | null {
  if (!hasMoveGrant) return mdfBoardIssueText('MDF_MOVE_PERMISSION_DENIED');
  if (snapshot.mode === 'read_only') return mdfBoardIssueText('MDF_READ_ONLY');
  if (snapshot.mode !== 'active') return mdfBoardIssueText('MDF_ENGINE_NOT_ACTIVE');
  if (snapshot.issues.length) return mdfBoardIssueText(snapshot.issues[0]!);
  if (card.issues.length) return mdfBoardIssueText(card.issues[0]!);
  const pending = snapshot.pendingJobs.find((job) => job.kind === card.kind && job.id === card.id);
  if (pending) return mdfBoardIssueText('MDF_PUBLICATION_PENDING');
  if (!card.acceptedRevision || card.acceptedRevision !== card.receivedRevision) {
    return mdfBoardIssueText('MDF_PUBLICATION_PENDING');
  }
  if (!card.commandToken || !MDF_COMMAND_TOKEN_PATTERN.test(card.commandToken)) {
    return mdfBoardIssueText('MDF_COMMAND_TOKEN_MISSING');
  }
  return null;
}

function orderNameOf(orderId: number, orders: readonly MdfPublishedOrderName[]): string | null {
  return orders.find((order) => order.orderId === orderId)?.orderName ?? null;
}

function resolveCardTitle(
  card: MdfPublishedCard,
  presentation: MdfPublishedCardPresentation | undefined,
): string {
  if (presentation && !presentation.stale && presentation.composition) {
    if (card.kind === 'packet') {
      const name = presentation.composition.programName || presentation.composition.externalKey;
      if (name) return name;
    } else if (card.kind === 'bath') {
      const cutJobName = presentation.composition.cutJobName;
      const resultNo = presentation.composition.resultNo;
      if (cutJobName) return resultNo != null ? `${cutJobName} №${resultNo}` : cutJobName;
    }
  }
  if (card.kind === 'bazisCutSet' && presentation?.live?.name) return presentation.live.name;
  return card.displayName;
}

export function buildMdfPublishedBoardCard(
  snapshot: MdfPublishedSnapshot,
  card: MdfPublishedCard,
  hasMoveGrant: boolean,
): MdfPublishedBoardCard {
  const presentation = snapshot.presentation.find((p) => p.kind === card.kind && p.id === card.id);
  const progressRows = snapshot.progress.filter((p) => p.kind === card.kind && p.id === card.id);
  const progressByOrderDetail = new Map(progressRows.map((row) => [`${row.orderId}:${row.detailId}`, row]));
  const memberRows = snapshot.members.filter((member) => member.kind === card.kind && member.id === card.id);

  // §5.6 finding 8: authorized membership + this card's own progress, keyed by (orderId, detailId)
  // — always available, independent of presentation/stale/kind (covers minimal cards and baths,
  // whose composition may carry no items at all).
  const memberByKey = new Map<string, { orderId: number; detailId: number; quantity: number }>();
  for (const member of memberRows) {
    const key = `${member.orderId}:${member.detailId}`;
    const existing = memberByKey.get(key);
    if (existing) existing.quantity += member.quantity;
    else memberByKey.set(key, { orderId: member.orderId, detailId: member.detailId, quantity: member.quantity });
  }
  const memberQuantities: MdfPublishedBoardMemberQuantity[] = [...memberByKey.values()]
    .map((row) => {
      const progress = progressByOrderDetail.get(`${row.orderId}:${row.detailId}`);
      return {
        orderId: row.orderId,
        orderName: orderNameOf(row.orderId, snapshot.orders),
        detailId: row.detailId,
        quantity: row.quantity,
        cut: progress?.cut ?? 0,
        laminated: progress?.laminated ?? 0,
      };
    })
    .sort((a, b) => a.orderId - b.orderId || a.detailId - b.detailId);

  const stale = !presentation || presentation.stale || !presentation.composition;
  // §5.6 finding 7: aggregate raw composition rows to one row per (orderId, detailId) —
  // presentation.composition.items can carry several raw rows (e.g. several packet rows) for the
  // same accounting position; without this, progress was shown (and re-shown) per raw row instead
  // of once per position, with quantity understated.
  const items: MdfPublishedBoardItem[] = (() => {
    if (stale || !presentation?.composition) return [];
    const byKey = new Map<string, {
      orderId: number; detailId: number | null; detailNumber: number | string | null;
      widthMm: number | null; heightMm: number | null; quantity: number;
    }>();
    let syntheticIndex = 0;
    for (const raw of presentation.composition.items) {
      // A null detailId cannot be attributed to an accounting position; keep each such row distinct.
      const key = raw.detailId !== null ? `${raw.orderId}:${raw.detailId}` : `__no-detail:${syntheticIndex++}`;
      const existing = byKey.get(key);
      if (existing) existing.quantity += raw.quantity;
      else byKey.set(key, { ...raw });
    }
    return [...byKey.values()].map((row) => {
      const progress = row.detailId !== null ? progressByOrderDetail.get(`${row.orderId}:${row.detailId}`) : undefined;
      return {
        orderId: row.orderId,
        orderName: orderNameOf(row.orderId, snapshot.orders),
        detailId: row.detailId,
        detailNumber: row.detailNumber,
        widthMm: row.widthMm,
        heightMm: row.heightMm,
        quantity: row.quantity,
        cut: progress?.cut ?? 0,
        laminated: progress?.laminated ?? 0,
      };
    });
  })();

  // §5.6 finding 8: whole-position totals for every (orderId, detailId) this card has membership
  // in — read straight from the single `snapshot.positions` truth, never summed across cards.
  const positionsIndex = indexMdfPublishedPositions(snapshot);
  // Retained facts (§5.2 empty/emptied BASIS): this card's own authorized progress at positions no longer in its current
  // membership still shows its counters and still associates the card with its orders (search). Never feeds commands.
  const retained = progressRows
    .filter((row) => !memberByKey.has(`${row.orderId}:${row.detailId}`) && (row.cut > 0 || row.laminated > 0))
    .map((row) => ({ orderId: row.orderId, orderName: orderNameOf(row.orderId, snapshot.orders), detailId: row.detailId }))
    .sort((a, b) => a.orderId - b.orderId || a.detailId - b.detailId);
  const positions: MdfPublishedBoardPositionTotal[] = [...memberQuantities, ...retained].map((member) => {
    const position = positionsIndex.get(`${member.orderId}:${member.detailId}`);
    return {
      orderId: member.orderId,
      orderName: member.orderName,
      detailId: member.detailId,
      required: position?.required ?? 0,
      creditedCut: position?.creditedCut ?? 0,
      creditedRolled: position?.creditedRolled ?? 0,
      remaining: position?.remaining ?? 0,
    };
  });

  const orderIds = [...new Set([...memberQuantities.map((m) => m.orderId), ...retained.map((r) => r.orderId),
    ...items.map((item) => item.orderId)])].sort((a, b) => a - b);
  const orderNames = orderIds.map((orderId) => orderNameOf(orderId, snapshot.orders)).filter((name): name is string => Boolean(name));

  const pendingJob = snapshot.pendingJobs.find((job) => job.kind === card.kind && job.id === card.id);
  const needsAttentionCode = pendingJob?.status === 'needs_attention' ? pendingJob.code ?? 'ACCEPTANCE_PENDING' : null;
  const requiresAttention = card.issues.length > 0 || needsAttentionCode !== null;
  const issueTexts = [...new Set([
    ...card.issues.map(mdfBoardIssueText),
    ...(needsAttentionCode ? [mdfBoardIssueText(needsAttentionCode)] : []),
  ])];
  const pendingNote = pendingJob?.status === 'pending' ? 'Обрабатывается' : null;

  // Live annotations (comments, rework, thumbs-up, BASIS name) are current-row values, never bound
  // to the accepted composition revision; the backend already gates them by full visibility.
  const live = presentation?.live ?? null;
  return {
    kind: card.kind,
    id: card.id,
    column: card.column,
    sourceCreatedAt: card.sourceCreatedAt,
    title: resolveCardTitle(card, presentation),
    orderIds,
    orderNames,
    stale,
    staleNote: stale ? 'данные файла изменились — ожидает пересчёта' : null,
    items,
    memberQuantities,
    positions,
    materialName: (!stale && presentation?.composition?.materialName) || null,
    hasSheetImage: Boolean(!stale && presentation?.composition?.hasSheetImage),
    cutJobName: (!stale && presentation?.composition?.cutJobName) || null,
    resultNo: (!stale && presentation?.composition?.resultNo) ?? null,
    rework: Boolean(live?.rework),
    comments: parseMdfLiveComments(live?.comments),
    requiresAttention,
    issueTexts,
    pendingNote,
    commandDisabledReason: mdfPublishedCardCommandDisabledReason(snapshot, card, hasMoveGrant),
    commandToken: card.commandToken ?? null,
  };
}

export function buildMdfPublishedBoardCards(
  snapshot: MdfPublishedSnapshot,
  hasMoveGrant: boolean,
): MdfPublishedBoardCard[] {
  return snapshot.cards.map((card) => buildMdfPublishedBoardCard(snapshot, card, hasMoveGrant));
}

export function groupMdfPublishedBoardCardsByColumn(
  cards: readonly MdfPublishedBoardCard[],
): Map<string, MdfPublishedBoardCard[]> {
  const byColumn = new Map<string, MdfPublishedBoardCard[]>();
  for (const card of cards) {
    const key = card.column ?? 'unknown';
    const bucket = byColumn.get(key);
    if (bucket) bucket.push(card);
    else byColumn.set(key, [card]);
  }
  return byColumn;
}

export function buildMdfUnregisteredLane(snapshot: MdfPublishedSnapshot): MdfPublishedUnregisteredCard[] {
  return snapshot.unregistered.map((source: MdfPublishedUnregisteredSource) => ({
    kind: source.kind,
    id: source.id,
    displayName: source.displayName,
    sourceCreatedAt: source.sourceCreatedAt,
    orderNames: source.orderIds
      .map((orderId) => orderNameOf(orderId, snapshot.orders))
      .filter((name): name is string => Boolean(name)),
  }));
}

/** Positions are already unique per (orderId, detailId) on the wire; this indexes them for O(1)
 * lookup and guards against accidentally re-deriving order/position totals from overlapping cards. */
export function indexMdfPublishedPositions(
  snapshot: MdfPublishedSnapshot,
): Map<string, MdfPublishedSnapshot['positions'][number]> {
  const byKey = new Map<string, MdfPublishedSnapshot['positions'][number]>();
  for (const position of snapshot.positions) byKey.set(`${position.orderId}:${position.detailId}`, position);
  return byKey;
}

function normalizeOrderKey(value: string): string {
  return value.trim().toLocaleLowerCase('ru-RU');
}

/** Visibility-only filter: order name chips selected by the user. No refetch — operates on
 * whatever is already loaded. */
export function filterMdfPublishedCardsByOrderNames(
  cards: readonly MdfPublishedBoardCard[],
  orderFilters: readonly string[],
): MdfPublishedBoardCard[] {
  const keys = new Set(orderFilters.map(normalizeOrderKey).filter(Boolean));
  if (keys.size === 0) return [...cards];
  return cards.filter((card) => card.orderNames.some((name) => keys.has(normalizeOrderKey(name))));
}

/** Visibility-only free-text filter over title/order names/displayed id. */
export function filterMdfPublishedCardsByText(
  cards: readonly MdfPublishedBoardCard[],
  search: string,
): MdfPublishedBoardCard[] {
  const needle = search.trim().toLocaleLowerCase('ru-RU');
  if (!needle) return [...cards];
  return cards.filter((card) =>
    card.title.toLocaleLowerCase('ru-RU').includes(needle)
    || card.id.toLocaleLowerCase('ru-RU').includes(needle)
    || card.orderNames.some((name) => name.toLocaleLowerCase('ru-RU').includes(needle)));
}


const MAX_SEARCH_ORDER_IDS = 100;

export interface MdfPublishedSearchPlanInput {
  /** The user's CURRENT full selection (every order-name chip presently in the search box) —
   * always the whole current set, never a delta. An empty array means the selection was cleared. */
  requestedOrderNames: readonly string[];
  /** Orders already named in the loaded snapshot (`orders[]`) — no async lookup needed for these. */
  knownOrders: readonly MdfPublishedOrderName[];
  /** Name → resolved order id (normalized key), or null when a lookup found nothing. Absent key =
   * not yet looked up. */
  resolvedOrderIds: ReadonlyMap<string, number | null>;
  /** The `searchOrderIds` currently applied (e.g. hook state) — used ONLY to detect a no-op (so the
   * caller can skip a redundant state update/refetch); NEVER merged into the result. §5.6 R2#2: a
   * name dropped from the current selection must disappear from the result too — union-with-past
   * semantics kept a removed/cleared order's cards exempt from the period filter forever. */
  currentSearchOrderIds: readonly number[];
}

export interface MdfPublishedSearchPlan {
  /** Names the caller must resolve (e.g. via an order search API) before they can be added. */
  namesNeedingResolution: string[];
  /** The ids for the CURRENT selection — known ids plus whatever is already resolved in
   * `resolvedOrderIds` — REPLACING any previous selection's ids entirely (including down to `[]`
   * when the selection is empty or resolves to nothing yet). `null` only when this exactly equals
   * `currentSearchOrderIds` already (genuine no-op — skip the update/refetch). */
  nextSearchOrderIds: number[] | null;
}

/** §5.6d / finding 6 / R2#2: deciding which `searchOrderIds` to request for the user's CURRENT
 * order-name selection, replacing (never unioning with) whatever was requested before — so
 * removing one tag, or clearing the selection entirely, drops exactly those orders' exemption from
 * the period filter. Pure — the actual order-name lookup is IO and stays with the caller.
 *
 * A "known" order (already named in the loaded snapshot's `orders[]`, e.g. via one recent card) is
 * NOT exempt from search: the default window fetch is time-scoped, not per-order, so an order with
 * one recent card can still have older cards outside the window. Being "known" only means the
 * order id needs no async name→id lookup — it still needs to be requested via `searchOrderIds` (so
 * the backend widens the fetch to ALL of that order's cards and exempts them from its display cut). */
export function planMdfPublishedSearchOrderIds(input: MdfPublishedSearchPlanInput): MdfPublishedSearchPlan {
  const knownIdByKey = new Map(input.knownOrders.map((order) => [normalizeOrderKey(order.orderName), order.orderId]));
  const namesNeedingResolution: string[] = [];
  const idsForSelection = new Set<number>();
  const seen = new Set<string>();
  for (const raw of input.requestedOrderNames) {
    const name = raw.trim();
    if (!name) continue;
    const key = normalizeOrderKey(name);
    if (seen.has(key)) continue;
    seen.add(key);
    const knownId = knownIdByKey.get(key);
    if (knownId !== undefined) {
      idsForSelection.add(knownId);
      continue;
    }
    if (!input.resolvedOrderIds.has(key)) {
      namesNeedingResolution.push(name);
      continue;
    }
    const orderId = input.resolvedOrderIds.get(key);
    if (orderId !== null && orderId !== undefined) idsForSelection.add(orderId);
  }
  const next = [...idsForSelection].sort((a, b) => a - b);
  const current = [...input.currentSearchOrderIds].sort((a, b) => a - b);
  const unchanged = next.length === current.length && next.every((id, index) => id === current[index]);
  if (unchanged) return { namesNeedingResolution, nextSearchOrderIds: null };
  return {
    namesNeedingResolution,
    nextSearchOrderIds: next.length > MAX_SEARCH_ORDER_IDS ? next.slice(0, MAX_SEARCH_ORDER_IDS) : next,
  };
}
