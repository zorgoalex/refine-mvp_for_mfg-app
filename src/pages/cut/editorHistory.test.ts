import { describe, expect, it } from 'vitest';
import { EDITOR_UNDO_LIMIT, isNoopDrop, pushHistory } from './editorHistory';

describe('pushHistory', () => {
  it('appends snapshots in order', () => {
    const h = pushHistory(pushHistory([], 'a'), 'b');
    expect(h).toEqual(['a', 'b']);
  });

  it('does not mutate the input history', () => {
    const input = ['a'];
    pushHistory(input, 'b');
    expect(input).toEqual(['a']);
  });

  it('caps at the limit, dropping the OLDEST entries', () => {
    let h: string[] = [];
    for (let i = 1; i <= 55; i++) h = pushHistory(h, `s${i}`);
    expect(h).toHaveLength(EDITOR_UNDO_LIMIT);
    expect(h[0]).toBe('s6'); // s1..s5 dropped
    expect(h[h.length - 1]).toBe('s55');
  });

  it('default limit is 50 steps', () => {
    expect(EDITOR_UNDO_LIMIT).toBe(50);
  });
});

describe('isNoopDrop', () => {
  it('plain click (same sheet, same position) is a no-op', () => {
    expect(
      isNoopDrop({ sourceSheetIndex: 2, targetSheetIndex: 2, fromXMm: 100, fromYMm: 50, toXMm: 100, toYMm: 50 }),
    ).toBe(true);
  });

  it('same-sheet move to a new position commits', () => {
    expect(
      isNoopDrop({ sourceSheetIndex: 2, targetSheetIndex: 2, fromXMm: 100, fromYMm: 50, toXMm: 101, toYMm: 50 }),
    ).toBe(false);
    expect(
      isNoopDrop({ sourceSheetIndex: 2, targetSheetIndex: 2, fromXMm: 100, fromYMm: 50, toXMm: 100, toYMm: 49 }),
    ).toBe(false);
  });

  it('cross-sheet drop commits even at identical coordinates', () => {
    expect(
      isNoopDrop({ sourceSheetIndex: 1, targetSheetIndex: 3, fromXMm: 100, fromYMm: 50, toXMm: 100, toYMm: 50 }),
    ).toBe(false);
  });
});
