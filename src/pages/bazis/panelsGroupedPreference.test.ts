import { describe, expect, it, vi, afterEach } from 'vitest';
import { loadPanelsGrouped, panelsGroupedKey, savePanelsGrouped } from './PanelsTab';

// node env: подменяем localStorage глобально на время теста
function withStorage(store: Record<string, string>) {
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => (key in store ? store[key] : null),
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
  });
  return store;
}

afterEach(() => vi.unstubAllGlobals());

describe('panels grouped per-user preference', () => {
  it('key is namespaced per user', () => {
    expect(panelsGroupedKey(42)).toBe('bazis-panels:grouped:42');
  });

  it('defaults to true when nothing is stored or storage is unavailable', () => {
    withStorage({});
    expect(loadPanelsGrouped(1)).toBe(true);
    vi.unstubAllGlobals();
    // node без localStorage — try/catch возвращает дефолт
    expect(loadPanelsGrouped(1)).toBe(true);
  });

  it('round-trips false and true per user', () => {
    const store = withStorage({});
    savePanelsGrouped(7, false);
    expect(store['bazis-panels:grouped:7']).toBe('false');
    expect(loadPanelsGrouped(7)).toBe(false);
    savePanelsGrouped(7, true);
    expect(loadPanelsGrouped(7)).toBe(true);
    // другой юзер не затронут
    expect(loadPanelsGrouped(8)).toBe(true);
  });
});
