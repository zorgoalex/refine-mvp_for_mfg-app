/**
 * Undo history for the manual cut-layout editor: a capped stack of
 * working-sheets snapshots. One entry per committed gesture (drag drop or
 * rotate) — SheetEditor fires onChange only on commit, never mid-drag.
 */
export const EDITOR_UNDO_LIMIT = 50;

/** Append a snapshot, dropping the oldest entries beyond the cap. */
export function pushHistory<T>(history: readonly T[], snapshot: T, limit: number = EDITOR_UNDO_LIMIT): T[] {
  const next = [...history, snapshot];
  return next.length > limit ? next.slice(next.length - limit) : next;
}
