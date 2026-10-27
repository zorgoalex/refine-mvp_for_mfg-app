import type { CncTelegramTodayColumn } from '../../api/types/cncTelegramApi.types';
import type { OrderStatusBoardColumn } from '../../api/types/orderStatusBoardApi.types';

/** A refreshed board keeps the objects of everything that did not change: memoized cards (`contentIdentity`) and
 * the memos downstream then re-render only the cards whose data changed, not the whole board. */
const withCollections = (_key: string, value: unknown) =>
  value instanceof Map ? { map: [...value] } : value instanceof Set ? { set: [...value] } : value;

function sameData(left: unknown, right: unknown): boolean {
  return left === right || JSON.stringify(left, withCollections) === JSON.stringify(right, withCollections);
}

/** `previous` when `next` holds the same data (Maps and Sets compared by content), else `next`. */
export function reuseIfSameData<T>(previous: T | null | undefined, next: T): T {
  return previous !== null && previous !== undefined && sameData(previous, next) ? previous : next;
}

function reuseList<T>(previous: readonly T[] | undefined, next: readonly T[], keyOf: (item: T) => string): T[] {
  const byKey = new Map((previous ?? []).map((item) => [keyOf(item), item]));
  return next.map((item) => {
    const old = byKey.get(keyOf(item));
    return old !== undefined && sameData(old, item) ? old : item;
  });
}

function sameItems<T>(left: readonly T[] | undefined, right: readonly T[]): boolean {
  return Boolean(left) && left!.length === right.length && left!.every((item, index) => item === right[index]);
}

export function reuseUnchangedCncColumns(
  previous: readonly CncTelegramTodayColumn[] | null,
  next: CncTelegramTodayColumn[],
): CncTelegramTodayColumn[] {
  if (!previous) return next;
  const previousByKey = new Map(previous.map((column) => [column.key, column]));
  const columns = next.map((column) => {
    const old = previousByKey.get(column.key);
    const packets = reuseList(old?.packets, column.packets, (packet) => packet.packetId);
    const baths = reuseList(old?.baths, column.baths, (bath) => bath.bathCardId);
    // `bazisCutSets` may be absent in an older backend's response (rolling deploy): it stays absent
    const bazisCutSets = column.bazisCutSets
      ? reuseList(old?.bazisCutSets, column.bazisCutSets, (set) => String(set.bazisCutSetId))
      : column.bazisCutSets;
    if (old && sameItems(old.packets, packets) && sameItems(old.baths, baths)
      && (old.bazisCutSets === bazisCutSets || (bazisCutSets !== undefined && sameItems(old.bazisCutSets, bazisCutSets)))
      && sameData({ ...old, packets: [], baths: [], bazisCutSets: [] },
        { ...column, packets: [], baths: [], bazisCutSets: [] })) return old;
    return bazisCutSets === undefined ? { ...column, packets, baths } : { ...column, packets, baths, bazisCutSets };
  });
  return sameItems(previous, columns) ? previous as CncTelegramTodayColumn[] : columns;
}

export function reuseUnchangedOrderBoardColumns(
  previous: readonly OrderStatusBoardColumn[] | null,
  next: OrderStatusBoardColumn[],
): OrderStatusBoardColumn[] {
  if (!previous) return next;
  const previousByKey = new Map(previous.map((column) => [column.key, column]));
  const columns = next.map((column) => {
    const old = previousByKey.get(column.key);
    const cards = reuseList(old?.cards, column.cards, (card) => String(card.orderId));
    if (old && sameItems(old.cards, cards) && old.total === column.total && old.nextCursor === column.nextCursor
      && sameData(old.status, column.status)) return old;
    return { ...column, cards };
  });
  return sameItems(previous, columns) ? previous as OrderStatusBoardColumn[] : columns;
}

/** Order cards split into display columns: an entry (card + readiness + missing details) whose data did not change
 * keeps its object, so its memoized card does not re-render. */
export function reuseUnchangedOrderEntries<T extends { card: { orderId: number } }, R extends Record<string, T[]>>(
  previous: R | null,
  next: R,
): R {
  if (!previous) return next;
  const result = { ...next };
  for (const key of Object.keys(next) as (keyof R)[]) {
    (result as Record<string, T[]>)[key as string] = reuseList(previous[key], next[key], (entry) => String(entry.card.orderId));
  }
  return result;
}

/** A map whose unchanged entries keep their values; the previous map itself when no entry changed (a context
 * value passed to every card frame). */
export function reuseUnchangedMap<K, V>(previous: ReadonlyMap<K, V> | null, next: ReadonlyMap<K, V>): ReadonlyMap<K, V> {
  if (!previous) return next;
  let changed = previous.size !== next.size;
  const result = new Map<K, V>();
  for (const [key, value] of next) {
    const old = previous.get(key);
    const kept = old !== undefined && sameData(old, value) ? old : value;
    if (kept !== old) changed = true;
    result.set(key, kept);
  }
  return changed ? result : previous;
}

/** The order-board columns as status options only (no cards): what an order card needs from them, unchanged while
 * only cards change. */
export function orderStatusOptionColumns(
  previous: readonly OrderStatusBoardColumn[] | null,
  columns: readonly OrderStatusBoardColumn[],
): OrderStatusBoardColumn[] {
  const options = columns.map((column) => ({ ...column, cards: [], total: 0, nextCursor: null }));
  return reuseIfSameData(previous as OrderStatusBoardColumn[] | null, options);
}
