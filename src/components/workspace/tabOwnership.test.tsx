import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { KeepAliveContext, useWorkspaceTabKey } from './KeepAliveContext';

let tabStore: typeof import('../../stores/tabStore');

describe('workspace tab ownership', () => {
  beforeAll(async () => {
    vi.stubGlobal('sessionStorage', createMemoryStorage());
    tabStore = await import('../../stores/tabStore');
  });

  afterAll(() => vi.unstubAllGlobals());

  it('keeps a hidden order update on its owner when the active route is /cut', () => {
    let resolvedTabKey = '';
    const Probe = () => {
      resolvedTabKey = useWorkspaceTabKey('/cut');
      return null;
    };

    renderToStaticMarkup(
      <KeepAliveContext.Provider value={{
        isActive: false,
        tabKey: '/orders/edit/42',
        workspaceActive: false,
        activationRevision: 1,
        documentVisible: true,
        surfaceActive: true,
      }}>
        <Probe />
      </KeepAliveContext.Provider>,
    );

    const store = tabStore.useTabStore.getState();
    store.openTab({ key: '/orders/edit/42', path: '/orders/edit/42', label: 'Заказ', resource: 'orders_view' });
    store.openTab({ key: '/cut', path: '/cut', label: 'Раскрой', resource: 'cut' });
    store.setTabTitle(resolvedTabKey, 'Кухня');
    store.setDirty(resolvedTabKey, true);

    const orderTab = tabStore.useTabStore.getState().tabs.find((tab) => tab.key === '/orders/edit/42');
    const cutTab = tabStore.useTabStore.getState().tabs.find((tab) => tab.key === '/cut');
    expect(orderTab).toMatchObject({ label: 'Кухня', dirty: true });
    expect(cutTab).toMatchObject({ label: 'Раскрой', dirty: false });
  });
});

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => Array.from(values.keys())[index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, String(value)),
  } as Storage;
}
