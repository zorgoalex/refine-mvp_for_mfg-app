import React, { useLayoutEffect, useReducer, useRef, useSyncExternalStore } from 'react';
import { useOutlet, useLocation } from 'react-router-dom';
import { useTabStore } from '../../stores/tabStore';
import {
  commitKeepAliveEvictions,
  countMountedHeavyOrderViews,
  planKeepAliveCache,
} from './keepAlive';
import {
  activateWorkspace,
  KeepAliveContext,
  type WorkspaceActivationTracker,
} from './KeepAliveContext';
import { useAppActivitySnapshot } from '../../performance/appActivityCoordinator';
import { useOrderLifecycleCohort } from '../../performance/orderLifecycleCohortStore';
import { recordOrderLifecycleMetric } from '../../performance/performanceRum';
import {
  captureWorkspaceCheckpoint,
  hasWorkspaceCheckpointAdapters,
  isWorkspaceCheckpointCircuitOpen,
} from '../../workspace/workspaceCheckpointRegistry';
import {
  getWorkspaceOperationPinsRevision,
  hasWorkspaceOperationPins,
  recordWorkspaceOperationEvictionPin,
  subscribeWorkspaceOperationPins,
} from '../../workspace/workspaceOperationPins';
import { getWorkspaceStateNamespace } from '../../workspace/workspaceStateNamespace';
import { recordMountedHeavyViewCount } from '../../workspace/workspaceKeepAliveDiagnostics';

interface LocalEvictionCircuit {
  namespace: string;
  open: boolean;
}

export const KeepAliveOutlet: React.FC = () => {
  const outlet = useOutlet();
  const location = useLocation();
  const tabs = useTabStore((state) => state.tabs);
  const activeKey = location.pathname;
  const cacheRef = useRef<Map<string, React.ReactNode>>(new Map());
  const localCircuitRef = useRef<LocalEvictionCircuit>({
    namespace: getWorkspaceStateNamespace(),
    open: false,
  });
  const previousActiveKeyRef = useRef(activeKey);
  const reportedHeavyDomCountRef = useRef<number | null>(null);
  const [, forceCacheRender] = useReducer((revision: number) => revision + 1, 0);
  const { documentVisible } = useAppActivitySnapshot();
  const cohort = useOrderLifecycleCohort();
  const operationPinsRevision = useSyncExternalStore(
    subscribeWorkspaceOperationPins,
    getWorkspaceOperationPinsRevision,
    getWorkspaceOperationPinsRevision,
  );
  const activationTrackerRef = useRef({
    lastActiveKey: '',
    nextRevision: 0,
    revisionByKey: new Map<string, number>(),
  });
  const namespace = getWorkspaceStateNamespace();
  const namespaceChanged = localCircuitRef.current.namespace !== namespace;
  const activationTracker = namespaceChanged
    ? createWorkspaceActivationTracker()
    : activationTrackerRef.current;
  const boundedHeavyOrderViews = cohort === 'treatment';
  const projectedActivationRevisions = projectActivationRevisions(
    activationTracker,
    activeKey,
  );

  const activeTab = tabs.find((tab) => tab.key === activeKey);
  const activeDirty = activeTab?.dirty ?? false;

  // Every active route renders through one stable keyed owner. A normally
  // ineligible route is removed only after it becomes inactive; this lets a
  // pin retain the same mounted tree without remounting when the pin starts.
  // The projected key set is render-local: cache/activation refs are committed
  // only in the layout effect, so an abandoned concurrent render leaves no
  // ghost workspace or LRU revision behind.
  const plannedCacheKeys = new Set(
    namespaceChanged ? [] : cacheRef.current.keys(),
  );
  if (outlet) plannedCacheKeys.add(activeKey);

  const tabsWithActive = activeTab
    ? tabs
    : [...tabs, { key: activeKey, dirty: activeDirty }];
  const pinnedKeys = new Set(
    [...plannedCacheKeys].filter((key) => hasWorkspaceOperationPins(key)),
  );
  const plan = planKeepAliveCache(plannedCacheKeys, {
    activeKey,
    tabs: tabsWithActive,
    pinnedKeys,
    boundedHeavyOrderViews,
    circuitOpen: (
      namespaceChanged ? false : localCircuitRef.current.open
    ) || isWorkspaceCheckpointCircuitOpen(),
    activationRevisionByKey: projectedActivationRevisions,
  });

  useLayoutEffect(() => {
    let committedStateChanged = false;
    if (namespaceChanged) {
      cacheRef.current.clear();
      activationTrackerRef.current = createWorkspaceActivationTracker();
      previousActiveKeyRef.current = activeKey;
      localCircuitRef.current = { namespace, open: false };
      reportedHeavyDomCountRef.current = null;
      if (outlet) cacheRef.current.set(activeKey, outlet);
      activateWorkspace(activationTrackerRef.current, activeKey);

      const heavyDomCount = countMountedHeavyOrderViews(cacheRef.current.keys());
      const diagnostics = recordMountedHeavyViewCount(heavyDomCount);
      reportedHeavyDomCountRef.current = heavyDomCount;
      recordOrderLifecycleMetric('heavy_dom_count', diagnostics.peakMountedHeavyViewCount);
      forceCacheRender();
      return;
    }
    if (outlet && !cacheRef.current.has(activeKey)) {
      cacheRef.current.set(activeKey, outlet);
      committedStateChanged = true;
    }
    if (activationTrackerRef.current.lastActiveKey !== activeKey) {
      activateWorkspace(activationTrackerRef.current, activeKey);
    }

    const previousActiveKey = previousActiveKeyRef.current;
    previousActiveKeyRef.current = activeKey;
    let deactivationCaptureFailed = false;
    if (
      boundedHeavyOrderViews
      && previousActiveKey !== activeKey
      && hasWorkspaceCheckpointAdapters(previousActiveKey)
      && !captureWorkspaceCheckpoint(previousActiveKey)
    ) {
      localCircuitRef.current.open = true;
      deactivationCaptureFailed = true;
    }

    const wasCircuitOpen = localCircuitRef.current.open && !deactivationCaptureFailed;
    const result = deactivationCaptureFailed
      ? { circuitOpened: true, evictedKeys: [] }
      : commitKeepAliveEvictions({
        plan,
        captureCheckpoint: captureWorkspaceCheckpoint,
        evict: (key) => cacheRef.current.delete(key),
        onPinnedEviction: recordWorkspaceOperationEvictionPin,
      });
    if (result.circuitOpened) localCircuitRef.current.open = true;

    const heavyDomCount = countMountedHeavyOrderViews(cacheRef.current.keys());
    if (reportedHeavyDomCountRef.current !== heavyDomCount) {
      reportedHeavyDomCountRef.current = heavyDomCount;
      const diagnostics = recordMountedHeavyViewCount(heavyDomCount);
      recordOrderLifecycleMetric('heavy_dom_count', diagnostics.peakMountedHeavyViewCount);
    }
    if (
      committedStateChanged
      || result.evictedKeys.length > 0
      || (result.circuitOpened && !wasCircuitOpen)
    ) {
      forceCacheRender();
    }
  }, [
    activeKey,
    boundedHeavyOrderViews,
    namespace,
    namespaceChanged,
    operationPinsRevision,
    outlet,
    plan,
  ]);

  const renderedCacheEntries = namespaceChanged
    ? outlet
      ? [[activeKey, outlet] as const]
      : []
    : Array.from(cacheRef.current.entries());

  return (
    <>
      {renderedCacheEntries.map(([key, node]) => (
        <KeepAliveContext.Provider key={`${namespace}\u0000${key}`} value={{
          isActive: key === activeKey,
          tabKey: key,
          workspaceActive: key === activeKey,
          activationRevision: projectedActivationRevisions.get(key) ?? 0,
          documentVisible,
          surfaceActive: true,
        }}>
          <div hidden={key !== activeKey} data-workspace-key={key}>{node}</div>
        </KeepAliveContext.Provider>
      ))}
    </>
  );
};

function projectActivationRevisions(
  tracker: WorkspaceActivationTracker,
  activeKey: string,
): ReadonlyMap<string, number> {
  if (tracker.lastActiveKey === activeKey) return tracker.revisionByKey;
  const projected = new Map(tracker.revisionByKey);
  projected.set(activeKey, tracker.nextRevision + 1);
  return projected;
}

function createWorkspaceActivationTracker(): WorkspaceActivationTracker {
  return {
    lastActiveKey: '',
    nextRevision: 0,
    revisionByKey: new Map<string, number>(),
  };
}
