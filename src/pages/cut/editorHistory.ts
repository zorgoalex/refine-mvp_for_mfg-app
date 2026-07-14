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

/**
 * True when a pointer-up commits NOTHING: same sheet and same position.
 * A plain selection click reaches handleUp too — without this check it would
 * fire onChange, burn an undo slot and re-validate a layout that didn't move.
 */
export function isNoopDrop(args: {
  sourceSheetIndex: number;
  targetSheetIndex: number;
  fromXMm: number;
  fromYMm: number;
  toXMm: number;
  toYMm: number;
}): boolean {
  return (
    args.targetSheetIndex === args.sourceSheetIndex &&
    args.toXMm === args.fromXMm &&
    args.toYMm === args.fromYMm
  );
}
