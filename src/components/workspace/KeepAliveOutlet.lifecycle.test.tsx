import React, { StrictMode, useEffect, useRef } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { MemoryRouter, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
  tabs: [] as Array<{ key: string; dirty: boolean }>,
  cohort: 'treatment' as 'disabled' | 'control' | 'treatment',
  captureResult: true,
  hasAdapters: true,
  globalCircuitOpen: false,
  pins: new Set<string>(),
  pinsRevision: 0,
  captureCheckpoint: vi.fn<(key: string) => boolean>(),
  recordPinnedEviction: vi.fn<(key: string) => boolean>(),
  recordMetric: vi.fn(),
  namespace: 'actor:A|session:1|scope:test',
  mounts: new Set<string>(),
  unmounts: [] as string[],
  mountedOwners: new Set<string>(),
  unmountedOwners: [] as string[],
}));

vi.mock('../../stores/tabStore', () => ({
  useTabStore: (selector: (state: { tabs: typeof harness.tabs }) => unknown) => selector({
    tabs: harness.tabs,
  }),
}));
vi.mock('../../performance/appActivityCoordinator', () => ({
  useAppActivitySnapshot: () => ({ documentVisible: true }),
}));
vi.mock('../../performance/orderLifecycleCohortStore', () => ({
  useOrderLifecycleCohort: () => harness.cohort,
}));
vi.mock('../../performance/performanceRum', () => ({
  recordOrderLifecycleMetric: (...args: unknown[]) => harness.recordMetric(...args),
}));
vi.mock('../../workspace/workspaceCheckpointRegistry', () => ({
  captureWorkspaceCheckpoint: (key: string) => harness.captureCheckpoint(key),
  hasWorkspaceCheckpointAdapters: () => harness.hasAdapters,
  isWorkspaceCheckpointCircuitOpen: () => harness.globalCircuitOpen,
}));
vi.mock('../../workspace/workspaceOperationPins', () => ({
  getWorkspaceOperationPinsRevision: () => harness.pinsRevision,
  hasWorkspaceOperationPins: (key: string) => harness.pins.has(key),
  recordWorkspaceOperationEvictionPin: (key: string) => harness.recordPinnedEviction(key),
  subscribeWorkspaceOperationPins: () => () => undefined,
}));
vi.mock('../../workspace/workspaceStateNamespace', () => ({
  getWorkspaceStateNamespace: () => harness.namespace,
}));

import { KeepAliveOutlet } from './KeepAliveOutlet';

let navigate: ReturnType<typeof useNavigate> | null = null;

function Layout() {
  navigate = useNavigate();
  return <KeepAliveOutlet />;
}

function Page() {
  const id = useParams().id ?? '';
  const ownerAtMount = useRef(harness.namespace).current;
  useEffect(() => {
    harness.mounts.add(id);
    harness.mountedOwners.add(`${ownerAtMount}:${id}`);
    return () => {
      harness.mounts.delete(id);
      harness.unmounts.push(id);
      harness.mountedOwners.delete(`${ownerAtMount}:${id}`);
      harness.unmountedOwners.push(`${ownerAtMount}:${id}`);
    };
  }, [id, ownerAtMount]);
  return <span data-page-owner={ownerAtMount}>{id}</span>;
}

describe('KeepAliveOutlet bounded lifecycle', () => {
  beforeEach(() => {
    const keys = ['A', 'B', 'C', 'D', 'E'].map((id) => `/orders/show/${id}`);
    harness.tabs = ['/orders', ...keys].map((key) => ({ key, dirty: false }));
    harness.cohort = 'treatment';
    harness.captureResult = true;
    harness.hasAdapters = true;
    harness.globalCircuitOpen = false;
    harness.pins.clear();
    harness.pinsRevision = 0;
    harness.captureCheckpoint.mockReset();
    harness.captureCheckpoint.mockImplementation(() => harness.captureResult);
    harness.recordPinnedEviction.mockReset();
    harness.recordPinnedEviction.mockReturnValue(true);
    harness.recordMetric.mockReset();
    harness.namespace = 'actor:A|session:1|scope:test';
    harness.mounts.clear();
    harness.unmounts = [];
    harness.mountedOwners.clear();
    harness.unmountedOwners = [];
    navigate = null;
  });

  it('keeps exact C/D/E mounted after the A/B/C/D/E activation sequence in StrictMode', async () => {
    const renderer = await renderAt('/orders/show/A');
    await navigateTo('/orders/show/B');
    await navigateTo('/orders/show/C');
    await navigateTo('/orders/show/D');
    await navigateTo('/orders/show/E');

    expect(readMountedWorkspaceKeys(renderer)).toEqual([
      '/orders/show/C',
      '/orders/show/D',
      '/orders/show/E',
    ]);
    expect([...harness.mounts].sort()).toEqual(['C', 'D', 'E']);
    expect(harness.unmounts).toEqual(expect.arrayContaining(['A', 'B']));
    expect(harness.recordMetric).toHaveBeenCalledWith('heavy_dom_count', 3);

    await navigateTo('/orders');
    expect(readMountedWorkspaceKeys(renderer)).toEqual([
      '/orders',
      '/orders/show/D',
      '/orders/show/E',
    ]);

    await unmountRenderer(renderer);
  });

  it('preserves legacy unbounded dirty edit workspaces in the control cohort', async () => {
    const keys = ['A', 'B', 'C', 'D', 'E'].map((id) => `/orders/edit/${id}`);
    harness.tabs = keys.map((key) => ({ key, dirty: true }));
    harness.cohort = 'control';
    const renderer = await renderAt(keys[0]);
    for (const key of keys.slice(1)) await navigateTo(key);

    expect(readMountedWorkspaceKeys(renderer)).toEqual(keys);
    expect([...harness.mounts].sort()).toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(harness.unmounts).toEqual([]);

    await unmountRenderer(renderer);
  });

  it('remounts the same route with a fresh owner when the auth namespace changes', async () => {
    const key = '/orders/edit/A';
    harness.tabs = [{ key, dirty: true }];
    const renderer = await renderAt(key);

    expect(readMountedPageOwners(renderer)).toEqual(['actor:A|session:1|scope:test']);
    harness.namespace = 'actor:B|session:2|scope:test';
    await navigateTo(`${key}?actor=B`);

    expect(readMountedWorkspaceKeys(renderer)).toEqual([key]);
    expect(readMountedPageOwners(renderer)).toEqual(['actor:B|session:2|scope:test']);
    expect(harness.mountedOwners).toEqual(new Set(['actor:B|session:2|scope:test:A']));
    expect(harness.unmountedOwners).toContain('actor:A|session:1|scope:test:A');

    await unmountRenderer(renderer);
  });

  it('keeps every mounted heavy node after a missing checkpoint opens the circuit', async () => {
    harness.hasAdapters = false;
    harness.captureResult = false;
    const renderer = await renderAt('/orders/show/A');
    await navigateTo('/orders/show/B');
    await navigateTo('/orders/show/C');
    await navigateTo('/orders/show/D');
    await navigateTo('/orders/show/E');

    expect(readMountedWorkspaceKeys(renderer)).toEqual([
      '/orders/show/A',
      '/orders/show/B',
      '/orders/show/C',
      '/orders/show/D',
      '/orders/show/E',
    ]);
    expect(harness.captureCheckpoint).toHaveBeenCalledWith('/orders/show/A');
    expect(harness.unmounts).toEqual([]);

    await unmountRenderer(renderer);
  });

  it('records an eviction pin, skips capture and remains fail-closed after release', async () => {
    harness.hasAdapters = false;
    harness.pins.add('/orders/show/A');
    const renderer = await renderAt('/orders/show/A');
    await navigateTo('/orders/show/B');
    await navigateTo('/orders/show/C');
    await navigateTo('/orders/show/D');

    expect(harness.recordPinnedEviction).toHaveBeenCalledWith('/orders/show/A');
    expect(harness.captureCheckpoint).not.toHaveBeenCalled();
    harness.pins.clear();
    harness.pinsRevision += 1;
    await navigateTo('/orders/show/E');

    expect(readMountedWorkspaceKeys(renderer)).toHaveLength(5);
    expect(harness.unmounts).toEqual([]);

    await unmountRenderer(renderer);
  });
});

async function renderAt(path: string): Promise<ReactTestRenderer> {
  let renderer: ReactTestRenderer | undefined;
  await act(async () => {
    renderer = create(
      <StrictMode>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route element={<Layout />}>
              <Route path="/orders" element={<span>orders list</span>} />
              <Route path="/orders/show/:id" element={<Page />} />
              <Route path="/orders/edit/:id" element={<Page />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </StrictMode>,
    );
    await Promise.resolve();
  });
  return renderer!;
}

async function navigateTo(path: string): Promise<void> {
  await act(async () => {
    navigate?.(path);
    await Promise.resolve();
  });
}

async function unmountRenderer(renderer: ReactTestRenderer): Promise<void> {
  await act(async () => {
    renderer.unmount();
    await Promise.resolve();
  });
}

function readMountedWorkspaceKeys(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAll((node) => typeof node.props['data-workspace-key'] === 'string')
    .map((node) => node.props['data-workspace-key'] as string)
    .sort();
}

function readMountedPageOwners(renderer: ReactTestRenderer): string[] {
  return renderer.root
    .findAll((node) => typeof node.props['data-page-owner'] === 'string')
    .map((node) => node.props['data-page-owner'] as string)
    .sort();
}
