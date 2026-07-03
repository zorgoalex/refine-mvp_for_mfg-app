import { beforeEach, describe, expect, it } from 'vitest';
import { getScanAction, setScanAction } from './scanPrefs';

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
});

describe('scanPrefs', () => {
  it('returns null before first choice', () => {
    expect(getScanAction(7)).toBeNull();
  });
  it('stores per user', () => {
    setScanAction(7, 'open-order');
    setScanAction(8, 'show-info');
    expect(getScanAction(7)).toBe('open-order');
    expect(getScanAction(8)).toBe('show-info');
  });
  it('ignores garbage values', () => {
    store.set('scanDefaultAction:7', 'nonsense');
    expect(getScanAction(7)).toBeNull();
  });
  it('survives missing localStorage', () => {
    delete (globalThis as Record<string, unknown>).localStorage;
    expect(getScanAction(7)).toBeNull();
    expect(() => setScanAction(7, 'open-order')).not.toThrow();
  });
});
