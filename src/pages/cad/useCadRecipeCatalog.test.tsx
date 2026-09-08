import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { QueryClient, QueryClientProvider, focusManager } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { catalogApi } = vi.hoisted(() => ({ catalogApi: vi.fn() }));
vi.mock('../../api/cadApi', () => ({ cadApi: { catalog: catalogApi } }));
import { useCadRecipeCatalog } from './useCadRecipeCatalog';

describe('CAD catalog refresh lifecycle', () => {
  let client: QueryClient;
  let renderer: ReactTestRenderer | undefined;
  let current: ReturnType<typeof useCadRecipeCatalog>;
  let state: { enabled: boolean; active: boolean; mappingOpen: boolean };
  const first = { recipes: [{ code: 'neoclassic', version: '1.0.0', status: 'production' }] };
  const next = { recipes: [...first.recipes, { code: 'neoclassic', version: '1.0.1', status: 'production' }] };

  function Probe() {
    current = useCadRecipeCatalog(state.enabled, state.active, state.mappingOpen);
    return null;
  }
  async function render() {
    await act(async () => {
      const element = <QueryClientProvider client={client}><Probe /></QueryClientProvider>;
      if (renderer) renderer.update(element);
      else renderer = create(element);
    });
  }
  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { refetchOnWindowFocus: false, cacheTime: 0 } } });
    state = { enabled: true, active: true, mappingOpen: false };
    catalogApi.mockReset().mockResolvedValue(first);
    focusManager.setFocused(true);
  });
  afterEach(() => {
    act(() => renderer?.unmount());
    renderer = undefined;
    client.clear();
    focusManager.setFocused(undefined);
  });

  it('refreshes on each modal opening without evicting cached recipes', async () => {
    await render();
    expect(catalogApi).toHaveBeenCalledTimes(1);
    catalogApi.mockResolvedValue(next);
    state.mappingOpen = true;
    await render();
    expect(catalogApi).toHaveBeenCalledTimes(2);
    expect(client.getQueryData(['cad-recipes'])).toEqual(next);
    state.mappingOpen = false;
    await render();
    expect(catalogApi).toHaveBeenCalledTimes(2);
    state.mappingOpen = true;
    await render();
    expect(catalogApi).toHaveBeenCalledTimes(3);
  });

  it('does not fetch while inactive or disabled; refreshes on activation', async () => {
    state.active = false;
    state.mappingOpen = true;
    await render();
    expect(catalogApi).not.toHaveBeenCalled();
    state.active = true;
    state.enabled = false;
    await render();
    expect(catalogApi).not.toHaveBeenCalled();
    state.enabled = true;
    await render();
    expect(catalogApi).toHaveBeenCalledTimes(1);
    state.active = false;
    await render();
    catalogApi.mockResolvedValue(next);
    state.active = true;
    await render();
    expect(catalogApi).toHaveBeenCalledTimes(2);
    expect(client.getQueryData(['cad-recipes'])).toEqual(next);
  });

  it('opts into focus refresh locally while inactive pages stay silent', async () => {
    await render();
    catalogApi.mockResolvedValue(next);
    await act(async () => { focusManager.setFocused(false); focusManager.setFocused(true); });
    expect(catalogApi).toHaveBeenCalledTimes(2);
    expect(client.getDefaultOptions().queries?.refetchOnWindowFocus).toBe(false);
    state.active = false;
    await render();
    await act(async () => { focusManager.setFocused(false); focusManager.setFocused(true); });
    expect(catalogApi).toHaveBeenCalledTimes(2);
  });

  it('keeps cached options after refresh failure and recovers on manual retry', async () => {
    await render();
    catalogApi.mockRejectedValue(new Error('CAD unavailable'));
    await act(async () => { await current.refetch(); });
    expect(client.getQueryState(['cad-recipes'])?.status).toBe('error');
    expect(client.getQueryData(['cad-recipes'])).toEqual(first);
    catalogApi.mockResolvedValue(next);
    await act(async () => { await current.refetch(); });
    expect(client.getQueryState(['cad-recipes'])?.status).toBe('success');
    expect(client.getQueryData(['cad-recipes'])).toEqual(next);
  });
});
