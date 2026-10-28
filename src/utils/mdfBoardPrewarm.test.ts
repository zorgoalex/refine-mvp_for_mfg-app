import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MDF_BOARD_RECENT_USE_MS, mdfBoardOpenedRecently, rememberMdfBoardOpened } from './mdfBoardPrewarm';

describe('habitual MDF board users', () => {
  let store: Map<string, string>;
  beforeEach(() => {
    store = new Map();
    vi.stubGlobal('window', { localStorage: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
    }, dispatchEvent: vi.fn() });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('warms the board after sign-in only for a user who opened it within the period, per user', () => {
    const now = 1_000_000_000_000;
    expect(mdfBoardOpenedRecently(7, now)).toBe(false);
    rememberMdfBoardOpened(7, now);
    expect(mdfBoardOpenedRecently(7, now + 60_000)).toBe(true);
    expect(mdfBoardOpenedRecently(8, now + 60_000)).toBe(false);
    expect(mdfBoardOpenedRecently(7, now + MDF_BOARD_RECENT_USE_MS + 1)).toBe(false);
    expect(mdfBoardOpenedRecently(null, now)).toBe(false);
  });

  it('works without storage (private mode): no warm-up, no error', () => {
    vi.stubGlobal('window', { localStorage: {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    } });
    expect(() => rememberMdfBoardOpened(7)).not.toThrow();
    expect(mdfBoardOpenedRecently(7)).toBe(false);
  });
});
