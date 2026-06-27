import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getStoredThemeMode,
  isThemeMode,
  setStoredThemeMode,
  themeModeStorageKey,
} from './themeStorage';

describe('themeStorage', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createLocalStorageMock());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses user-scoped keys', () => {
    expect(themeModeStorageKey('7')).toBe('erp.themeMode.7');
  });

  it('reads and writes valid theme modes per user', () => {
    setStoredThemeMode('7', 'dark');
    setStoredThemeMode('8', 'light');

    expect(getStoredThemeMode('7')).toBe('dark');
    expect(getStoredThemeMode('8')).toBe('light');
  });

  it('ignores invalid stored values', () => {
    localStorage.setItem('erp.themeMode.7', 'system');

    expect(getStoredThemeMode('7')).toBeNull();
    expect(isThemeMode('system')).toBe(false);
    expect(isThemeMode('dark')).toBe(true);
  });
});

function createLocalStorageMock(): Storage {
  let store: Record<string, string> = {};
  return {
    get length() {
      return Object.keys(store).length;
    },
    clear: () => {
      store = {};
    },
    getItem: (key: string) => store[key] ?? null,
    key: (index: number) => Object.keys(store)[index] ?? null,
    removeItem: (key: string) => {
      delete store[key];
    },
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
  };
}
