import React, { useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { useOutlet, useLocation } from 'react-router-dom';
import { useTabStore } from '../../stores/tabStore';
import { nextKeepAliveCache } from './keepAlive';
import { activateWorkspace, KeepAliveContext } from './KeepAliveContext';
import { useAppActivitySnapshot } from '../../performance/appActivityCoordinator';
import {
  captureWorkspaceCheckpoint,
  hasWorkspaceCheckpointAdapters,
} from '../../workspace/workspaceCheckpointRegistry';
import {
  getWorkspaceOperationPinsRevision,
  hasWorkspaceOperationPins,
  recordWorkspaceOperationEvictionPin,
  subscribeWorkspaceOperationPins,
} from '../../workspace/workspaceOperationPins';

export const KeepAliveOutlet: React.FC = () => {
  const outlet = useOutlet();
  const location = useLocation();
  const tabs = useTabStore((s) => s.tabs);
  const activeKey = location.pathname;
  const cacheRef = useRef<Map<string, React.ReactNode>>(new Map());
  const reportedPinnedEvictionsRef = useRef<Set<string>>(new Set());
  const { documentVisible } = useAppActivitySnapshot();
  useSyncExternalStore(
    subscribeWorkspaceOperationPins,
    getWorkspaceOperationPinsRevision,
    getWorkspaceOperationPinsRevision,
  );
  const activationTrackerRef = useRef({
    lastActiveKey: '',
    nextRevision: 0,
    revisionByKey: new Map<string, number>(),
  });
  const activationTracker = activationTrackerRef.current;
  const previousActiveKeyRef = useRef(activeKey);
  activateWorkspace(activationTracker, activeKey);

  useLayoutEffect(() => {
    const previousActiveKey = previousActiveKeyRef.current;
    previousActiveKeyRef.current = activeKey;
    if (previousActiveKey !== activeKey && hasWorkspaceCheckpointAdapters(previousActiveKey)) {
      captureWorkspaceCheckpoint(previousActiveKey);
    }
  }, [activeKey]);

  const activeTab = tabs.find((t) => t.key === activeKey);
  const activeDirty = activeTab?.dirty ?? false;

  // Every active route renders through one stable keyed owner. A normally
  // ineligible route is removed only after it becomes inactive; this lets a
  // pin retain the same mounted tree without remounting when the pin starts.
  if (outlet && !cacheRef.current.has(activeKey)) {
    cacheRef.current.set(activeKey, outlet);
  }

  // Evict per policy.
  const tabsWithActive = activeTab
    ? tabs
    : [...tabs, { key: activeKey, dirty: activeDirty }];
  const evictionCandidates = new Set([...cacheRef.current.keys(), activeKey]);
  const pinnedKeys = new Set(
    [...evictionCandidates].filter((key) => hasWorkspaceOperationPins(key)),
  );
  const keep = nextKeepAliveCache(new Set(cacheRef.current.keys()), {
    activeKey,
    tabs: tabsWithActive,
    pinnedKeys,
    onPinnedEviction: (key) => {
      if (reportedPinnedEvictionsRef.current.has(key)) return;
      if (recordWorkspaceOperationEvictionPin(key)) {
        reportedPinnedEvictionsRef.current.add(key);
      }
    },
  });
  for (const key of Array.from(cacheRef.current.keys())) {
    if (!keep.has(key)) cacheRef.current.delete(key);
  }
  for (const key of Array.from(reportedPinnedEvictionsRef.current)) {
    if (!pinnedKeys.has(key)) reportedPinnedEvictionsRef.current.delete(key);
  }

  return (
    <>
      {Array.from(cacheRef.current.entries()).map(([key, node]) => (
        <KeepAliveContext.Provider key={key} value={{
          isActive: key === activeKey,
          tabKey: key,
          workspaceActive: key === activeKey,
          activationRevision: activationTracker.revisionByKey.get(key) ?? 0,
          documentVisible,
          surfaceActive: true,
        }}>
          <div hidden={key !== activeKey} data-workspace-key={key}>{node}</div>
        </KeepAliveContext.Provider>
      ))}
    </>
  );
};
