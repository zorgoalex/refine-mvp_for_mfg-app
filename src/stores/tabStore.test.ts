import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

let mod: typeof import('./tabStore');

describe('tabStore', () => {
  beforeAll(async () => {
    vi.stubGlobal('sessionStorage', createMemoryStorage());
    mod = await import('./tabStore');
  });
  afterEach(() => mod.useTabStore.setState({ tabs: [] }, false));
  afterAll(() => vi.unstubAllGlobals());

  it('openTab keeps a custom label set via setTabTitle (location re-sync must not clobber it)', () => {
    const s = mod.useTabStore.getState();
    s.openTab({ key: '/bazis/projects/6', path: '/bazis/projects/6', label: 'Базис-проекты', resource: 'bazis' });
    s.setTabTitle('/bazis/projects/6', 'Шкаф');
    s.openTab({ key: '/bazis/projects/6', path: '/bazis/projects/6?revision=7', label: 'Базис-проекты', resource: 'bazis' });
    const tab = mod.useTabStore.getState().tabs.find((t) => t.key === '/bazis/projects/6');
    expect(tab?.label).toBe('Шкаф');
    expect(tab?.path).toBe('/bazis/projects/6?revision=7');
  });

  it('openTab dedupes by key but updates path (query preserved)', () => {
    const s = mod.useTabStore.getState();
    s.openTab({ key: '/orders', path: '/orders?status=1', label: 'Заказы', resource: 'orders_view' });
    s.openTab({ key: '/orders', path: '/orders?status=2', label: 'Заказы', resource: 'orders_view' });
    const tabs = mod.useTabStore.getState().tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0].path).toBe('/orders?status=2');
  });

  it('computeNeighborPath returns right neighbor, else left, else /orders', () => {
    const tabs = [
      { key: '/a', path: '/a', label: 'a', resource: 'a', dirty: false },
      { key: '/b', path: '/b', label: 'b', resource: 'b', dirty: false },
      { key: '/c', path: '/c', label: 'c', resource: 'c', dirty: false },
    ];
    expect(mod.computeNeighborPath(tabs, '/b')).toBe('/c'); // right
    expect(mod.computeNeighborPath(tabs, '/c')).toBe('/b'); // left (last)
    expect(mod.computeNeighborPath([tabs[0]], '/a')).toBe('/orders'); // last tab fallback
  });

  it('hasAnyDirty reflects any dirty tab', () => {
    expect(mod.hasAnyDirty([{ key: '/a', path: '/a', label: 'a', resource: 'a', dirty: false }])).toBe(false);
    expect(mod.hasAnyDirty([{ key: '/a', path: '/a', label: 'a', resource: 'a', dirty: true }])).toBe(true);
  });

  it('persists {key,path,label,resource} (not dirty) to sessionStorage', () => {
    mod.useTabStore.getState().openTab({ key: '/orders', path: '/orders', label: 'Заказы', resource: 'orders_view' });
    mod.useTabStore.getState().setDirty('/orders', true);
    const raw = sessionStorage.getItem('workspace-tabs') || '';
    expect(raw).toContain('/orders');
    expect(raw).not.toContain('"dirty":true');
  });
});

function createMemoryStorage(): Storage {
  const v = new Map<string, string>();
  return {
    get length() { return v.size; },
    clear() { v.clear(); },
    getItem: (k) => (v.has(k) ? v.get(k)! : null),
    key: (i) => Array.from(v.keys())[i] ?? null,
    removeItem: (k) => { v.delete(k); },
    setItem: (k, val) => { v.set(k, String(val)); },
  } as Storage;
}
