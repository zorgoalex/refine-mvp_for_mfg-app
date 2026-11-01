import React, { Suspense, lazy } from 'react';
import { act, create } from 'react-test-renderer';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
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
  seenLocations: [] as string[],
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
const seen: string[] = [];

function Layout() {
  navigate = useNavigate();
  return <Suspense fallback={<span>loading</span>}><KeepAliveOutlet /></Suspense>;
}

function Probe({ page }: { page: string }) {
  const { pathname } = useLocation();
  seen.push(`${page} ${pathname}`);
  return <span>{page}</span>;
}

let releaseMaterials: () => void = () => undefined;
const LazyMaterials = lazy(() => new Promise<{ default: React.FC }>((resolve) => {
  releaseMaterials = () => resolve({ default: () => <Probe page="materials" /> });
}));
let release: () => void = () => undefined;
const LazyContacts = lazy(() => new Promise<{ default: React.FC }>((resolve) => {
  release = () => resolve({ default: () => <Probe page="client-contacts" /> });
}));

describe('KeepAliveOutlet with a lazy route behind Suspense', () => {
  beforeEach(() => {
    harness.tabs = [{ key: '/materials', dirty: false }, { key: '/client-contacts', dirty: false }];
    harness.cohort = 'treatment';
    harness.captureCheckpoint.mockReset();
    harness.captureCheckpoint.mockReturnValue(true);
    seen.length = 0;
  });

  it('the page being left never sees the lazy route address, while the chunk loads and after', async () => {
    let renderer: ReturnType<typeof create> | undefined;
    await act(async () => {
      renderer = create(
        <MemoryRouter initialEntries={['/materials']}>
          <Routes>
            <Route element={<Layout />}>
              <Route path="/materials" element={<Probe page="materials" />} />
              <Route path="/client-contacts" element={<LazyContacts />} />
            </Route>
          </Routes>
        </MemoryRouter>,
        { unstable_isConcurrent: true },
      );
      await Promise.resolve();
    });
    await act(async () => { navigate?.('/client-contacts'); await Promise.resolve(); });
    await act(async () => { release(); await new Promise((r) => setTimeout(r, 0)); });
    expect(seen).toContain('client-contacts /client-contacts');
    expect(seen.filter((s) => s.startsWith('materials ')).every((s) => s === 'materials /materials')).toBe(true);
    await act(async () => { renderer!.unmount(); });
  });

  it('a lazy page left before its chunk loaded never renders with the next route address', async () => {
    let renderer: ReturnType<typeof create> | undefined;
    harness.tabs = [{ key: '/start', dirty: false }, { key: '/materials', dirty: false }, { key: '/client-contacts', dirty: false }];
    await act(async () => {
      renderer = create(
        <MemoryRouter initialEntries={['/start']}>
          <Routes>
            <Route element={<Layout />}>
              <Route path="/start" element={<Probe page="start" />} />
              <Route path="/materials" element={<LazyMaterials />} />
              <Route path="/client-contacts" element={<LazyContacts />} />
            </Route>
          </Routes>
        </MemoryRouter>,
        { unstable_isConcurrent: true },
      );
      await Promise.resolve();
    });
    await act(async () => { navigate?.('/materials'); await Promise.resolve(); });
    await act(async () => { navigate?.('/client-contacts'); await Promise.resolve(); });
    await act(async () => { releaseMaterials(); await new Promise((r) => setTimeout(r, 0)); });
    await act(async () => { release(); await new Promise((r) => setTimeout(r, 0)); });
    expect(seen).toContain('client-contacts /client-contacts');
    expect(seen.filter((s) => s.startsWith('materials ')).every((s) => s === 'materials /materials')).toBe(true);
    await act(async () => { renderer!.unmount(); });
  });
});
