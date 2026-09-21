import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserIdentity } from '../types/auth';

const user: UserIdentity = { id: '7', username: 'a', role: 'admin', permissions: ['orders.view'] };
const details = [1, 2, 3].map(index => ({ height: 600 + index * 10, width: 400 + index * 10, quantity: index }));

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: key => { values.delete(key); },
    clear: () => values.clear(),
    key: index => [...values.keys()][index] ?? null,
  };
}

async function seedPreviousDocument() {
  const { authSession } = await import('../api/authSession');
  const storeModule = await import('../stores/orderFormStore');
  // A reload can follow multiple prior login/scope transitions, not only generation 1.
  authSession.clear();
  authSession.clear();
  authSession.setUser(user);
  authSession.setAccessToken('old-token');
  const store = storeModule.getOrderDraftStore('new');
  store.getState().setHeader({ order_name: 'Before F5', client_id: 12 });
  details.forEach(detail => store.getState().addDetail(detail as any));
  const key = storeModule.getOrderDraftStorageKey('new');
  expect(key).toContain('|session:3|');
  return key;
}

async function freshDocument() {
  // Recreate in-memory JS modules, retaining only the tab's sessionStorage.
  vi.resetModules();
  const { installWorkspaceStateLifecycle } = await import('./workspaceStateLifecycle');
  const { authSession } = await import('../api/authSession');
  const { authApi } = await import('../api/authApi');
  const storeModule = await import('../stores/orderFormStore');
  installWorkspaceStateLifecycle();
  expect(authSession.getSessionGeneration()).toBe(0);
  return { authSession, authApi, ...storeModule };
}

function mockRefresh(nextUser = user) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    accessToken: 'restored-token', user: nextUser,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
}

function expectDraft(state: any) {
  expect(state.header).toMatchObject({ order_name: 'Before F5', client_id: 12 });
  expect(state.details.map(({ height, width, quantity }: any) => ({ height, width, quantity }))).toEqual(details);
  expect(state.isDirty).toBe(true);
}

describe('order drafts across authenticated document bootstrap', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('sessionStorage', memoryStorage());
    vi.stubEnv('VITE_API_URL', '');
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('preserves a same-actor/scope draft through actual refresh publication on F5', async () => {
    const oldKey = await seedPreviousDocument();
    const boot = await freshDocument();
    mockRefresh();
    await boot.authApi.refresh();
    expect(boot.authSession.getSessionGeneration()).toBe(1);
    expectDraft(boot.getOrderDraftStore('new').getState());
    expect(sessionStorage.getItem(oldKey)).toBeNull();
    expect(sessionStorage.getItem(boot.getOrderDraftStorageKey('new'))).toContain('Before F5');
  });

  it.each(['anonymous', 'corrupt', 'clean', 'saved-create'] as const)(
    'does not restore %s storage on initial identity', async kind => {
      const key = await seedPreviousDocument();
      const raw = sessionStorage.getItem(key)!;
      if (kind === 'anonymous') {
        sessionStorage.removeItem(key);
        sessionStorage.setItem(key.replace('actor:7|', 'actor:anonymous|'), raw);
      } else if (kind === 'corrupt') sessionStorage.setItem(key, '{invalid');
      else {
        const value = JSON.parse(raw);
        if (kind === 'clean') value.state.isDirty = false;
        else value.state.header.order_id = 123;
        sessionStorage.setItem(key, JSON.stringify(value));
      }
      const boot = await freshDocument();
      mockRefresh();
      await boot.authApi.refresh();
      expect(sessionStorage.length).toBe(0);
      expect(boot.getOrderDraftStore('new').getState().details).toEqual([]);
    },
  );

  it('uses the newest generation and never revives an older dirty draft over a clean one', async () => {
    const oldKey = await seedPreviousDocument();
    const value = JSON.parse(sessionStorage.getItem(oldKey)!);
    value.state.isDirty = false;
    sessionStorage.setItem(oldKey.replace('|session:3|', '|session:10|'), JSON.stringify(value));
    const boot = await freshDocument();
    mockRefresh();
    await boot.authApi.refresh();
    expect(sessionStorage.length).toBe(0);
    expect(boot.getOrderDraftStore('new').getState().details).toEqual([]);
  });

  it.each(['actor', 'scope'] as const)('rejects an old draft when the confirmed %s differs', async boundary => {
    const oldKey = await seedPreviousDocument();
    const boot = await freshDocument();
    mockRefresh({ ...user, ...(boundary === 'actor' ? { id: '8' } : { permissions: ['orders.update'] }) });
    await boot.authApi.refresh();
    expect(sessionStorage.getItem(oldKey)).toBeNull();
    expect(boot.getOrderDraftStore('new').getState().details).toEqual([]);
  });

  it.each(['clear', 'expire'] as const)('never preserves storage after explicit %s during bootstrap', async method => {
    const oldKey = await seedPreviousDocument();
    const boot = await freshDocument();
    boot.authSession[method]();
    mockRefresh();
    await boot.authApi.refresh();
    expect(sessionStorage.getItem(oldKey)).toBeNull();
    expect(boot.getOrderDraftStore('new').getState().details).toEqual([]);
  });

  it.each(['actor', 'scope', 'logout'] as const)('clears recovered drafts on a subsequent %s boundary', async boundary => {
    await seedPreviousDocument();
    const boot = await freshDocument();
    mockRefresh();
    await boot.authApi.refresh();
    const draft = boot.getOrderDraftStore('new');
    expectDraft(draft.getState());
    const key = boot.getOrderDraftStorageKey('new');
    if (boundary === 'logout') boot.authSession.clear();
    else boot.authSession.setUser({ ...user, ...(boundary === 'actor' ? { id: '8' } : { permissions: ['orders.update'] }) });
    expect(sessionStorage.getItem(key)).toBeNull();
    expect(draft.getState().details).toEqual([]);
    expect(boot.getOrderDraftStore('new').getState().details).toEqual([]);
  });
});
