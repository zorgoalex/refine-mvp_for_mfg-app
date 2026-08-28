import { describe, expect, it, vi } from 'vitest';
import {
  handleVitePreloadError,
  isStaleChunkLoadError,
  reloadPageOnceForStaleChunk,
} from './staleChunkReload';

function createStorage() {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
  };
}

function createEnvironment(entrySrc = 'https://mebelkz.app/assets/index-old.js') {
  return {
    sessionStorage: createStorage(),
    location: { reload: vi.fn() },
    document: {
      querySelectorAll: vi.fn(() => [{ src: entrySrc }]),
    },
    globalThis: {},
  };
}

describe('stale chunk reload recovery', () => {
  it('detects Vite dynamic import failures', () => {
    expect(
      isStaleChunkLoadError(
        new TypeError(
          'Failed to fetch dynamically imported module: https://mebelkz.app/assets/edit-b4c054b6.js',
        ),
      ),
    ).toBe(true);
    expect(
      isStaleChunkLoadError(
        new TypeError(
          'Expected a JavaScript-or-Wasm module script but the server responded with a MIME type of "text/html".',
        ),
      ),
    ).toBe(true);
    expect(isStaleChunkLoadError(new Error('ordinary render failure'))).toBe(false);
  });

  it('reloads once for the current entry bundle', () => {
    const environment = createEnvironment();
    const error = new TypeError('Failed to fetch dynamically imported module: /assets/edit-old.js');

    expect(reloadPageOnceForStaleChunk(error, environment)).toBe(true);
    expect(reloadPageOnceForStaleChunk(error, environment)).toBe(false);
    expect(environment.location.reload).toHaveBeenCalledTimes(1);
    expect(environment.sessionStorage.setItem).toHaveBeenCalledWith(
      'erp.staleChunkReload:https://mebelkz.app/assets/index-old.js',
      '1',
    );
  });

  it('allows one reload for a different deployed entry bundle', () => {
    const environment = createEnvironment('https://mebelkz.app/assets/index-old.js');
    const error = new TypeError('Failed to fetch dynamically imported module: /assets/edit-old.js');

    expect(reloadPageOnceForStaleChunk(error, environment)).toBe(true);
    environment.document.querySelectorAll.mockReturnValue([
      { src: 'https://mebelkz.app/assets/index-new.js' },
    ]);

    expect(reloadPageOnceForStaleChunk(error, environment)).toBe(true);
    expect(environment.location.reload).toHaveBeenCalledTimes(2);
  });

  it('uses an in-memory marker when sessionStorage is unavailable', () => {
    const environment = createEnvironment();
    environment.sessionStorage.getItem.mockImplementation(() => {
      throw new Error('storage disabled');
    });

    const error = new TypeError('Failed to fetch dynamically imported module: /assets/edit-old.js');

    expect(reloadPageOnceForStaleChunk(error, environment)).toBe(true);
    expect(reloadPageOnceForStaleChunk(error, environment)).toBe(false);
    expect(environment.location.reload).toHaveBeenCalledTimes(1);
  });

  it('uses an in-memory marker when sessionStorage is absent', () => {
    const environment = createEnvironment();
    const { sessionStorage: _sessionStorage, ...withoutSessionStorage } = environment;
    const error = new TypeError('Failed to fetch dynamically imported module: /assets/edit-old.js');

    expect(reloadPageOnceForStaleChunk(error, withoutSessionStorage)).toBe(true);
    expect(reloadPageOnceForStaleChunk(error, withoutSessionStorage)).toBe(false);
    expect(environment.location.reload).toHaveBeenCalledTimes(1);
  });

  it('handles Vite preload errors before React renders the failed route', () => {
    const event = new Event('vite:preloadError', { cancelable: true });
    Object.assign(event, {
      payload: new TypeError('Failed to fetch dynamically imported module: /assets/edit-old.js'),
    });

    expect(handleVitePreloadError(event, createEnvironment())).toBe(true);
    expect(event.defaultPrevented).toBe(true);
  });
});
