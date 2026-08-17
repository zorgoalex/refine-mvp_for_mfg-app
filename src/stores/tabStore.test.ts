import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { authSession } from '../api/authSession';

let mod: typeof import('./tabStore');
const TEST_USER = { id: '7', username: 'manager', role: 'manager' };

describe('tabStore', () => {
  beforeAll(async () => {
    vi.stubGlobal('localStorage', createMemoryStorage());
    vi.stubGlobal('sessionStorage', createMemoryStorage());
    authSession.setUser(TEST_USER);
    mod = await import('./tabStore');
  });
  afterEach(() => {
    authSession.setUser(null);
    localStorage.clear();
    sessionStorage.clear();
    authSession.setUser(TEST_USER);
    mod.syncWorkspaceTabsForCurrentUser();
  });
  afterAll(() => {
    authSession.setUser(null);
    vi.unstubAllGlobals();
  });

  it('openTab keeps a custom label set via setTabTitle (location re-sync must not clobber it)', () => {
    const s = mod.useTabStore.getState();
    s.openTab({ key: '/bazis/projects/6', path: '/bazis/projects/6', label: 'Базис-проекты', resource: 'bazis' });
    s.setTabTitle('/bazis/projects/6', 'Шкаф');
    s.openTab({
      key: '/bazis/projects/6',
      path: '/bazis/projects/6?revision=7',
      label: 'Базис-проекты',
      resource: 'bazis',
      preserveLabel: true,
    });
    const tab = mod.useTabStore.getState().tabs.find((t) => t.key === '/bazis/projects/6');
    expect(tab?.label).toBe('Шкаф');
    expect(tab?.path).toBe('/bazis/projects/6?revision=7');
  });

  it('openTab restores the route label for a static page', () => {
    const s = mod.useTabStore.getState();
    s.openTab({ key: '/cut', path: '/cut', label: 'Раскрой', resource: 'cut' });
    s.setTabTitle('/cut', '2557');
    s.openTab({
      key: '/cut',
      path: '/cut',
      label: 'Раскрой',
      resource: 'cut',
      preserveLabel: false,
    });
    expect(mod.useTabStore.getState().tabs[0].label).toBe('Раскрой');
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

  it('resolveTabOpenerKey links only a newly opened tab to the previous open tab', () => {
    const tabs = [
      { key: '/orders', path: '/orders?status=1', label: 'Заказы', resource: 'orders_view', dirty: false },
      { key: '/calendar', path: '/calendar', label: 'Календарь', resource: 'calendar', dirty: false },
    ];

    expect(mod.resolveTabOpenerKey(tabs, '/orders/show/42', '/orders')).toBe('/orders');
    expect(mod.resolveTabOpenerKey(tabs, '/calendar', '/orders')).toBeUndefined();
    expect(mod.resolveTabOpenerKey(tabs, '/orders/show/42', '/missing')).toBeUndefined();
    expect(mod.resolveTabOpenerKey(tabs, '/orders', '/orders')).toBeUndefined();
  });

  it('computeCloseTargetPath prefers the opener tab over the visual neighbor', () => {
    const tabs = [
      { key: '/orders', path: '/orders?status=1', label: 'Заказы', resource: 'orders_view', dirty: false },
      {
        key: '/orders/show/42',
        path: '/orders/show/42',
        label: '42',
        resource: 'orders_view',
        dirty: false,
        openerKey: '/orders',
      },
      { key: '/calendar', path: '/calendar', label: 'Календарь', resource: 'calendar', dirty: false },
    ];

    expect(mod.computeCloseTargetPath(tabs, '/orders/show/42')).toBe('/orders?status=1');
  });

  it('computeCloseTargetPath falls back to the neighbor when opener is absent', () => {
    const tabs = [
      { key: '/orders', path: '/orders', label: 'Заказы', resource: 'orders_view', dirty: false },
      {
        key: '/orders/show/42',
        path: '/orders/show/42',
        label: '42',
        resource: 'orders_view',
        dirty: false,
        openerKey: '/missing',
      },
      { key: '/calendar', path: '/calendar', label: 'Календарь', resource: 'calendar', dirty: false },
    ];

    expect(mod.computeCloseTargetPath(tabs, '/orders/show/42')).toBe('/calendar');
  });

  it('hasAnyDirty reflects any dirty tab', () => {
    expect(mod.hasAnyDirty([{ key: '/a', path: '/a', label: 'a', resource: 'a', dirty: false }])).toBe(false);
    expect(mod.hasAnyDirty([{ key: '/a', path: '/a', label: 'a', resource: 'a', dirty: true }])).toBe(true);
  });

  it('persists tab identity and opener (not dirty) to user-scoped localStorage', () => {
    mod.useTabStore.getState().openTab({ key: '/orders', path: '/orders', label: 'Заказы', resource: 'orders_view' });
    mod.useTabStore.getState().openTab({
      key: '/orders/show/42',
      path: '/orders/show/42',
      label: '42',
      resource: 'orders_view',
      openerKey: '/orders',
    });
    mod.useTabStore.getState().setDirty('/orders', true);
    const raw = localStorage.getItem(mod.workspaceTabsStorageKey(TEST_USER.id)) || '';
    expect(raw).toContain('/orders');
    expect(raw).toContain('"openerKey":"/orders"');
    expect(raw).not.toContain('"dirty":true');
    expect(sessionStorage.getItem(mod.LEGACY_WORKSPACE_TABS_STORAGE_KEY)).toBeNull();
  });

  it('migrates the legacy sessionStorage payload once for the current user', () => {
    const legacy = JSON.stringify({
      state: {
        tabs: [{ key: '/cut', path: '/cut', label: 'Раскрой', resource: 'cut', dirty: false }],
      },
      version: 1,
    });
    authSession.setUser(null);
    localStorage.clear();
    sessionStorage.setItem(mod.LEGACY_WORKSPACE_TABS_STORAGE_KEY, legacy);

    authSession.setUser(TEST_USER);
    mod.syncWorkspaceTabsForCurrentUser();

    expect(mod.useTabStore.getState().tabs.map((tab) => tab.key)).toEqual(['/cut']);
    expect(localStorage.getItem(mod.workspaceTabsStorageKey(TEST_USER.id))).toBe(legacy);
    expect(sessionStorage.getItem(mod.LEGACY_WORKSPACE_TABS_STORAGE_KEY)).toBeNull();
  });

  it('isolates and restores open tabs for each authenticated user', () => {
    mod.useTabStore.getState().openTab({
      key: '/orders',
      path: '/orders?status=1',
      label: 'Заказы',
      resource: 'orders_view',
    });

    authSession.setUser({ id: '8', username: 'operator', role: 'operator' });
    mod.syncWorkspaceTabsForCurrentUser();
    expect(mod.useTabStore.getState().tabs).toEqual([]);
    mod.useTabStore.getState().openTab({
      key: '/calendar',
      path: '/calendar',
      label: 'Календарь',
      resource: 'calendar',
    });

    authSession.setUser(TEST_USER);
    mod.syncWorkspaceTabsForCurrentUser();
    expect(mod.useTabStore.getState().tabs.map((tab) => tab.path)).toEqual(['/orders?status=1']);
  });

  it('migration removes legacy stale labels from persisted tabs', () => {
    const migrated = mod.migrateWorkspaceTabs(
      {
        tabs: [
          { key: '/cut', path: '/cut', label: '2557', resource: 'cut', dirty: false },
          {
            key: '/orders/edit/42',
            path: '/orders/edit/42',
            label: 'Старый заказ',
            resource: 'orders_view',
            dirty: false,
          },
        ],
      },
      0,
    ) as { tabs: Array<{ label: string }> };

    expect(migrated.tabs.map((tab) => tab.label)).toEqual(['Раскрой', 'Старый заказ']);
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
