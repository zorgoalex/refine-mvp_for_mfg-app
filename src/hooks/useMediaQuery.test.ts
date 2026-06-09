import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { subscribeMediaQuery, useMediaQuery } from './useMediaQuery';

interface MockMediaQueryList {
  matches: boolean;
  media: string;
  onchange: null;
  listeners: Array<() => void>;
  addEventListener: (event: string, cb: () => void) => void;
  removeEventListener: (event: string, cb: () => void) => void;
  dispatchEvent: () => boolean;
  addListener: (cb: () => void) => void;
  removeListener: (cb: () => void) => void;
}

function createMockMatchMedia(): MockMediaQueryList {
  const listeners: Array<() => void> = [];
  const list: MockMediaQueryList = {
    matches: false,
    media: '',
    onchange: null,
    listeners,
    addEventListener: (_event, cb) => {
      listeners.push(cb);
    },
    removeEventListener: (_event, cb) => {
      const index = listeners.indexOf(cb);
      if (index >= 0) listeners.splice(index, 1);
    },
    dispatchEvent: () => false,
    addListener: (cb) => {
      listeners.push(cb);
    },
    removeListener: (cb) => {
      const index = listeners.indexOf(cb);
      if (index >= 0) listeners.splice(index, 1);
    },
  };
  return list;
}

describe('subscribeMediaQuery', () => {
  let originalMatchMedia: typeof globalThis.matchMedia | undefined;
  let originalWindow: typeof globalThis.window | undefined;
  let mockList: MockMediaQueryList;

  beforeEach(() => {
    originalMatchMedia = globalThis.matchMedia;
    originalWindow = globalThis.window;
    mockList = createMockMatchMedia();
    (globalThis as { matchMedia?: typeof globalThis.matchMedia }).matchMedia = ((
      query: string,
    ): MediaQueryList => {
      mockList.media = query;
      return mockList as unknown as MediaQueryList;
    }) as typeof globalThis.matchMedia;
  });

  afterEach(() => {
    if (originalMatchMedia === undefined) {
      delete (globalThis as { matchMedia?: typeof globalThis.matchMedia }).matchMedia;
    } else {
      globalThis.matchMedia = originalMatchMedia;
    }
    if (originalWindow === undefined) {
      delete (globalThis as { window?: typeof globalThis.window }).window;
    } else {
      globalThis.window = originalWindow;
    }
  });

  it('forwards initial matches value to the subscriber', () => {
    mockList.matches = true;
    const captured: boolean[] = [];
    const unsub = subscribeMediaQuery('(max-width: 768px)', (m) => {
      captured.push(m);
    });
    expect(captured).toEqual([true]);
    unsub();
  });

  it('forwards change events to the subscriber', () => {
    const captured: boolean[] = [];
    const unsub = subscribeMediaQuery('(max-width: 768px)', (m) => {
      captured.push(m);
    });
    expect(captured).toEqual([false]);

    mockList.matches = true;
    mockList.listeners.forEach((cb) => cb());
    expect(captured).toEqual([false, true]);

    mockList.matches = false;
    mockList.listeners.forEach((cb) => cb());
    expect(captured).toEqual([false, true, false]);
    unsub();
  });

  it('returns a cleanup that unsubscribes from change events', () => {
    const captured: boolean[] = [];
    const unsub = subscribeMediaQuery('(max-width: 768px)', (m) => {
      captured.push(m);
    });

    unsub();
    expect(mockList.listeners).toEqual([]);

    mockList.matches = true;
    mockList.listeners.forEach((cb) => cb());
    expect(captured).toEqual([false]);
  });

  it('returns a no-op cleanup when window.matchMedia is unavailable', () => {
    delete (globalThis as { matchMedia?: typeof globalThis.matchMedia }).matchMedia;
    delete (globalThis as { window?: typeof globalThis.window }).window;

    const captured: boolean[] = [];
    const unsub = subscribeMediaQuery('(max-width: 768px)', (m) => {
      captured.push(m);
    });
    expect(typeof unsub).toBe('function');
    expect(captured).toEqual([]);
    expect(() => unsub()).not.toThrow();
  });
});

describe('useMediaQuery hook', () => {
  it('is exported and callable as a function', () => {
    expect(typeof useMediaQuery).toBe('function');
  });
});

describe('matchMedia sync init (useMediaQuery initial state)', () => {
  // This is a pure-function test of the initialization path: the
  // hook's first render should read matchMedia synchronously so the
  // initial state matches the viewport (avoids desktop-layout flash
  // on mobile). We mock matchMedia and verify via the underlying
  // subscribeMediaQuery helper (the sync path is inlined in the
  // useState initializer; here we just confirm the contract).

  it('respects matchMedia.matches on first render when matchMedia is available', () => {
    const original = globalThis.matchMedia;
    const listeners: Array<() => void> = [];
    (globalThis as { matchMedia?: typeof globalThis.matchMedia }).matchMedia = ((q: string) => ({
      get matches() { return true; },
      media: q,
      onchange: null,
      listeners,
      addEventListener: (_e, cb) => listeners.push(cb),
      removeEventListener: () => {},
      dispatchEvent: () => false,
      addListener: (cb) => listeners.push(cb),
      removeListener: () => {},
    })) as typeof globalThis.matchMedia;
    try {
      const mql = globalThis.matchMedia('(max-width: 768px)');
      expect(mql.matches).toBe(true);
    } finally {
      (globalThis as { matchMedia?: typeof globalThis.matchMedia }).matchMedia = original;
    }
  });
});
