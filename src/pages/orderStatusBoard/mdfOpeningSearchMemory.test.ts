import { describe, expect, it } from 'vitest';
import { createMdfOpeningSearchMemory } from './mdfOpeningSearchMemory';

const DAY = '2026-11-03';
const NEXT_DAY = '2026-11-04';

describe('MDF board: order-number search on the next opening', () => {
  it('keeps it when coming back to the still-open board tab (an order opened from a card)', () => {
    const memory = createMdfOpeningSearchMemory();
    expect(memory.keepsSearch(7, DAY)).toBe(false); // first opening
    memory.shown(7, DAY);
    memory.hidden(true);
    expect(memory.keepsSearch(7, DAY)).toBe(true);
    memory.shown(7, DAY); // back on the board
    expect(memory.keepsSearch(7, DAY)).toBe(true);
  });

  it('clears it when the board tab is closed — the active one or a hidden one', () => {
    const active = createMdfOpeningSearchMemory();
    active.shown(7, DAY);
    active.hidden(false); // closing the active tab removes it before the page hides
    expect(active.keepsSearch(7, DAY)).toBe(false);

    const hidden = createMdfOpeningSearchMemory();
    hidden.shown(7, DAY);
    hidden.hidden(true);
    hidden.tabClosed();
    expect(hidden.keepsSearch(7, DAY)).toBe(false);
  });

  it('clears it on a new day: by the timer while hidden, or on a return right after midnight', () => {
    const timer = createMdfOpeningSearchMemory();
    timer.shown(7, DAY);
    timer.hidden(true);
    timer.reset(); // midnight timer
    timer.hidden(true); // the hidden page re-runs its effect on the new day
    expect(timer.keepsSearch(7, NEXT_DAY)).toBe(false);

    const early = createMdfOpeningSearchMemory();
    early.shown(7, DAY);
    early.hidden(true);
    expect(early.keepsSearch(7, NEXT_DAY)).toBe(false); // back at 00:00:05, before the timer tick

    const leftAfterMidnight = createMdfOpeningSearchMemory();
    leftAfterMidnight.shown(7, DAY); // searched at 23:59
    leftAfterMidnight.shown(7, NEXT_DAY); // a re-render after midnight does not move the opening day
    leftAfterMidnight.hidden(true); // left at 00:00:02
    expect(leftAfterMidnight.keepsSearch(7, NEXT_DAY)).toBe(false); // back at 00:00:05
  });

  it('a hidden prewarm mount is not a return: the first real opening clears a persisted search', () => {
    const memory = createMdfOpeningSearchMemory();
    memory.hidden(true); // mounted hidden with a persisted MDF tab
    expect(memory.keepsSearch(7, DAY)).toBe(false);
  });

  it('another user starts fresh: switched while hidden or while the board is shown', () => {
    const whileHidden = createMdfOpeningSearchMemory();
    whileHidden.shown(7, DAY);
    whileHidden.hidden(true);
    expect(whileHidden.keepsSearch(8, DAY)).toBe(false);
    expect(whileHidden.keepsSearch(null, DAY)).toBe(false);

    const whileShown = createMdfOpeningSearchMemory();
    whileShown.shown(7, DAY);
    whileShown.reset(); // identity changed while the board was shown
    whileShown.shown(8, DAY);
    whileShown.hidden(true);
    expect(whileShown.keepsSearch(8, DAY)).toBe(true); // B's own search, B's own return
    expect(whileShown.keepsSearch(7, DAY)).toBe(false);
  });
});
