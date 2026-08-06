export const TOUCH_BOARD_LONG_PRESS_MS = 260;
export const TOUCH_BOARD_SLOP_PX = 8;
export const TOUCH_BOARD_EDGE_PX = 56;
export const TOUCH_BOARD_MAX_SCROLL_PX = 18;

export interface TouchBoardPoint {
  x: number;
  y: number;
}

export function exceedsTouchBoardSlop(
  start: TouchBoardPoint,
  current: TouchBoardPoint,
): boolean {
  const deltaX = current.x - start.x;
  const deltaY = current.y - start.y;
  return deltaX * deltaX + deltaY * deltaY > TOUCH_BOARD_SLOP_PX ** 2;
}

export function shouldActivateTouchBoardDrag(
  elapsedMs: number,
  start: TouchBoardPoint,
  current: TouchBoardPoint,
): boolean {
  return elapsedMs >= TOUCH_BOARD_LONG_PRESS_MS && !exceedsTouchBoardSlop(start, current);
}

export function isTouchBoardDestination(
  candidateKey: string | null,
  sourceKey: string,
  validKeys: ReadonlySet<string>,
): candidateKey is string {
  return candidateKey !== null && candidateKey !== sourceKey && validKeys.has(candidateKey);
}

export function touchBoardEdgeScrollDelta(
  coordinate: number,
  start: number,
  end: number,
): number {
  if (end <= start) return 0;
  if (coordinate < start + TOUCH_BOARD_EDGE_PX) {
    const ratio = Math.min(1, Math.max(0, (start + TOUCH_BOARD_EDGE_PX - coordinate) / TOUCH_BOARD_EDGE_PX));
    return -Math.ceil(ratio * TOUCH_BOARD_MAX_SCROLL_PX);
  }
  if (coordinate > end - TOUCH_BOARD_EDGE_PX) {
    const ratio = Math.min(1, Math.max(0, (coordinate - (end - TOUCH_BOARD_EDGE_PX)) / TOUCH_BOARD_EDGE_PX));
    return Math.ceil(ratio * TOUCH_BOARD_MAX_SCROLL_PX);
  }
  return 0;
}

export function claimTouchBoardDrop(
  completed: boolean,
  candidateKey: string | null,
  sourceKey: string,
  validKeys: ReadonlySet<string>,
): { completed: boolean; targetKey: string | null } {
  if (completed || !isTouchBoardDestination(candidateKey, sourceKey, validKeys)) {
    return { completed, targetKey: null };
  }
  return { completed: true, targetKey: candidateKey };
}
