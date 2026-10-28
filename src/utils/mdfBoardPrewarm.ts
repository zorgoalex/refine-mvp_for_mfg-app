export const MDF_BOARD_SNAPSHOT_READY_EVENT = 'erp:mdf-board-snapshot-ready';

let mdfBoardSnapshotReady = false;

export function markMdfBoardSnapshotReady(): void {
  mdfBoardSnapshotReady = true;
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(MDF_BOARD_SNAPSHOT_READY_EVENT));
  }
}

export function isMdfBoardSnapshotReady(): boolean {
  return mdfBoardSnapshotReady;
}

/** The board's data is warmed right after sign-in for users who opened it within this period (habitual users). */
export const MDF_BOARD_RECENT_USE_MS = 7 * 24 * 60 * 60 * 1000;
const RECENT_USE_KEY = 'erp.mdfBoard.openedAt.';

/** Remembers (per user, in this browser) that the board was opened. */
export function rememberMdfBoardOpened(userId: unknown, now = Date.now()): void {
  if (userId === undefined || userId === null) return;
  try {
    window.localStorage.setItem(`${RECENT_USE_KEY}${String(userId)}`, String(now));
  } catch {
    // no storage: no warm-up after sign-in, the board loads as usual
  }
}

/** True when this user opened the board in this browser within MDF_BOARD_RECENT_USE_MS. */
export function mdfBoardOpenedRecently(userId: unknown, now = Date.now()): boolean {
  if (userId === undefined || userId === null) return false;
  try {
    const openedAt = Number(window.localStorage.getItem(`${RECENT_USE_KEY}${String(userId)}`));
    return Number.isFinite(openedAt) && openedAt > 0 && now - openedAt >= 0 && now - openedAt <= MDF_BOARD_RECENT_USE_MS;
  } catch {
    return false;
  }
}
