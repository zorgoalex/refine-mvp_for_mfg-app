import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const outlet = readFileSync(resolve(__dirname, 'KeepAliveOutlet.tsx'), 'utf8');
const policy = readFileSync(resolve(__dirname, 'keepAlive.ts'), 'utf8');

describe('KeepAliveOutlet guards', () => {
  it('renders cached tabs in <div hidden=...> keyed off active', () => {
    expect(outlet).toContain('hidden={key !== activeKey}');
  });
  it('exposes isActive via KeepAliveContext', () => {
    expect(outlet).toContain('KeepAliveContext.Provider');
    expect(outlet).toContain('isActive');
  });
  it('pins each mounted screen to the tab key that owns it', () => {
    expect(outlet).toContain('tabKey: key');
  });
  it('publishes workspace activity, visibility and activation revision', () => {
    expect(outlet).toContain('workspaceActive: key === activeKey');
    expect(outlet).toContain('activationRevision:');
    expect(outlet).toContain('documentVisible');
    expect(outlet).toContain('useAppActivitySnapshot');
    expect(outlet).not.toContain("document.addEventListener('visibilitychange'");
  });
  it('commits a missing route node in layout and never replaces it on return', () => {
    expect(outlet).toContain('!cacheRef.current.has(activeKey)');
    expect(outlet).toContain('cacheRef.current.set(activeKey, outlet)');
    const layoutCommit = outlet.indexOf('useLayoutEffect(() =>');
    expect(outlet.indexOf('cacheRef.current.set(activeKey, outlet)')).toBeGreaterThan(layoutCommit);
    expect(outlet.indexOf('activateWorkspace(activationTrackerRef.current, activeKey)'))
      .toBeGreaterThan(layoutCommit);
  });
  it('plans every active route through one stable cache owner before tab sync', () => {
    expect(outlet).toContain('const activeDirty = activeTab?.dirty ?? false');
    expect(outlet).toContain('namespaceChanged ? [] : cacheRef.current.keys()');
    expect(outlet).toContain('if (outlet) plannedCacheKeys.add(activeKey)');
    expect(outlet).toContain('tabsWithActive');
    expect(outlet).toContain("{ key: activeKey, dirty: activeDirty }");
  });
  it('drops cached owner trees and LRU state across auth namespace changes', () => {
    const layoutCommit = outlet.indexOf('useLayoutEffect(() =>');
    expect(outlet.indexOf('cacheRef.current.clear()')).toBeGreaterThan(layoutCommit);
    expect(outlet.indexOf('activationTrackerRef.current = createWorkspaceActivationTracker()'))
      .toBeGreaterThan(layoutCommit);
    expect(outlet).toContain('previousActiveKeyRef.current = activeKey');
    expect(outlet).toContain('key={`${namespace}\\u0000${key}`}');
  });
  it('keeps /calendar excluded by default and activates only exact operation pins', () => {
    expect(policy).toContain("'/calendar'");
    expect(outlet).toContain('.filter((key) => hasWorkspaceOperationPins(key))');
    expect(outlet).toContain('onPinnedEviction: recordWorkspaceOperationEvictionPin');
    expect(outlet).toContain('subscribeWorkspaceOperationPins');
  });
  it('enables bounded heavy-order LRU only for the treatment cohort', () => {
    expect(outlet).toContain("const boundedHeavyOrderViews = cohort === 'treatment'");
    expect(outlet).toContain('activationRevisionByKey: projectedActivationRevisions');
    expect(policy).toContain('MAX_INACTIVE_HEAVY_ORDER_VIEWS = 2');
    expect(policy).toContain("key.startsWith('/orders/show/')");
  });
  it('commits checkpointed eviction in a layout effect and opens a local fail-closed circuit', () => {
    expect(outlet).toContain('useLayoutEffect');
    expect(outlet).toContain('commitKeepAliveEvictions');
    expect(outlet).toContain('captureCheckpoint: captureWorkspaceCheckpoint');
    expect(outlet).toContain('localCircuitRef.current.open = true');
    expect(outlet.indexOf('useLayoutEffect')).toBeLessThan(outlet.indexOf('captureCheckpoint: captureWorkspaceCheckpoint'));
  });
  it('publishes the mounted heavy DOM count without counting the orders list slot', () => {
    expect(outlet).toContain('recordMountedHeavyViewCount(heavyDomCount)');
    expect(outlet).toContain("recordOrderLifecycleMetric('heavy_dom_count', diagnostics.peakMountedHeavyViewCount)");
    expect(policy).toContain('isLightweightOrdersListKey');
  });
  it('adds no new keep-alive dependency (hand-rolled over useOutlet)', () => {
    expect(outlet).toContain('useOutlet');
    expect(outlet).not.toContain('react-activation');
  });
});
