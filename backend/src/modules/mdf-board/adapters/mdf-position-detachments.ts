import type { DatabaseClient } from '../../../database/database.types';
import { mdfPositionKey } from '../domain/mdf-quantities';

/**
 * §5.4e shared resolver: terminal source-scoped detachments (migration 191). In source S a detached (order, detail)
 * position counts nowhere — every line of S at that position (any revision, any line key, including new roots) is
 * history only. Every consumer (receipt, snapshot, allocation, quarantine, projection) filters through this.
 */
const mdfSourceKey = (source: { kind: string; id: string }) => JSON.stringify([source.kind, source.id]);

export type MdfDetachedPositions = ReadonlyMap<string, ReadonlySet<string>>;

export async function loadMdfDetachedPositions(tx: DatabaseClient,
  sources: readonly { kind: string; id: string }[]): Promise<MdfDetachedPositions> {
  const result = new Map<string, Set<string>>();
  if (!sources.length) return result;
  const rows = (await tx.query<{ kind: string; id: string; orderId: number; detailId: number }>(`SELECT d.source_kind kind,
      d.source_id id,d.order_id::float8 "orderId",d.detail_id::float8 "detailId" FROM mdf_position_detachments d
    JOIN unnest($1::text[],$2::text[]) s(kind,id) ON d.source_kind=s.kind AND d.source_id=s.id`,
  [sources.map(s => s.kind), sources.map(s => s.id)])).rows;
  for (const row of rows) {
    const key = mdfSourceKey(row);
    const set = result.get(key) ?? new Set<string>();
    set.add(mdfPositionKey(row));
    result.set(key, set);
  }
  return result;
}

export function isMdfLineDetached(detached: MdfDetachedPositions,
  line: { kind: string; id: string; orderId: number; detailId: number }): boolean {
  return detached.get(mdfSourceKey(line))?.has(mdfPositionKey(line)) === true;
}

/** Lines of a source that still count (not at a position detached in that source). */
export function mdfAttachedLines<T extends { kind: string; id: string; orderId: number; detailId: number }>(
  detached: MdfDetachedPositions, lines: readonly T[]): T[] {
  return detached.size ? lines.filter(line => !isMdfLineDetached(detached, line)) : [...lines];
}
