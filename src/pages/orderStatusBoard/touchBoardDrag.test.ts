import { describe, expect, it } from 'vitest';
import {
  TOUCH_BOARD_LONG_PRESS_MS,
  TOUCH_BOARD_SLOP_PX,
  claimTouchBoardDrop,
  exceedsTouchBoardSlop,
  isTouchBoardDestination,
  shouldActivateTouchBoardDrag,
  touchBoardEdgeScrollDelta,
} from './touchBoardDrag';

describe('touch status-board drag contract', () => {
  const start = { x: 100, y: 100 };

  it('activates only after the long press without exceeding movement slop', () => {
    expect(shouldActivateTouchBoardDrag(TOUCH_BOARD_LONG_PRESS_MS - 1, start, start)).toBe(false);
    expect(shouldActivateTouchBoardDrag(TOUCH_BOARD_LONG_PRESS_MS, start, start)).toBe(true);
    expect(shouldActivateTouchBoardDrag(
      TOUCH_BOARD_LONG_PRESS_MS,
      start,
      { x: start.x + TOUCH_BOARD_SLOP_PX + 1, y: start.y },
    )).toBe(false);
  });

  it('cancels pre-activation movement only after the configured radial slop', () => {
    expect(exceedsTouchBoardSlop(start, { x: 104, y: 106 })).toBe(false);
    expect(exceedsTouchBoardSlop(start, { x: 109, y: 100 })).toBe(true);
  });

  it('accepts only a different destination from the permission-filtered set', () => {
    const valid = new Set(['ready', 'done']);
    expect(isTouchBoardDestination('ready', 'new', valid)).toBe(true);
    expect(isTouchBoardDestination('new', 'new', valid)).toBe(false);
    expect(isTouchBoardDestination('hidden', 'new', valid)).toBe(false);
    expect(isTouchBoardDestination(null, 'new', valid)).toBe(false);
  });

  it('computes bounded edge-scroll speed and leaves the center still', () => {
    expect(touchBoardEdgeScrollDelta(102, 100, 500)).toBeLessThan(0);
    expect(touchBoardEdgeScrollDelta(498, 100, 500)).toBeGreaterThan(0);
    expect(touchBoardEdgeScrollDelta(300, 100, 500)).toBe(0);
    expect(Math.abs(touchBoardEdgeScrollDelta(100, 100, 500))).toBeLessThanOrEqual(18);
  });

  it('claims a valid drop once and rejects repeated completion', () => {
    const valid = new Set(['ready']);
    expect(claimTouchBoardDrop(false, 'ready', 'new', valid)).toEqual({
      completed: true,
      targetKey: 'ready',
    });
    expect(claimTouchBoardDrop(true, 'ready', 'new', valid)).toEqual({
      completed: true,
      targetKey: null,
    });
    expect(claimTouchBoardDrop(false, 'hidden', 'new', valid)).toEqual({
      completed: false,
      targetKey: null,
    });
  });
});
