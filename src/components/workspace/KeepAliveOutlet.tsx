import React, { useRef } from 'react';
import { useOutlet, useLocation } from 'react-router-dom';
import { useTabStore } from '../../stores/tabStore';
import { isKeepAliveEligible, nextKeepAliveCache } from './keepAlive';
import { activateWorkspace, KeepAliveContext } from './KeepAliveContext';
import { useAppActivitySnapshot } from '../../performance/appActivityCoordinator';

export const KeepAliveOutlet: React.FC = () => {
  const outlet = useOutlet();
  const location = useLocation();
  const tabs = useTabStore((s) => s.tabs);
  const activeKey = location.pathname;
  const cacheRef = useRef<Map<string, React.ReactNode>>(new Map());
  const { documentVisible } = useAppActivitySnapshot();
  const activationTrackerRef = useRef({
    lastActiveKey: '',
    nextRevision: 0,
    revisionByKey: new Map<string, number>(),
  });
  const activationTracker = activationTrackerRef.current;
  activateWorkspace(activationTracker, activeKey);

  const activeTab = tabs.find((t) => t.key === activeKey);
  const activeDirty = activeTab?.dirty ?? false;
  const eligible = isKeepAliveEligible(activeKey, { dirty: activeDirty });

  if (eligible && outlet && !cacheRef.current.has(activeKey)) {
    cacheRef.current.set(activeKey, outlet);
  }

  // Evict per policy.
  const tabsWithActive = activeTab || !eligible
    ? tabs
    : [...tabs, { key: activeKey, dirty: activeDirty }];
  const keep = nextKeepAliveCache(new Set(cacheRef.current.keys()), {
    activeKey,
    tabs: tabsWithActive,
  });
  for (const key of Array.from(cacheRef.current.keys())) {
    if (!keep.has(key)) cacheRef.current.delete(key);
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
      {!eligible && (
        <KeepAliveContext.Provider value={{
          isActive: true,
          tabKey: activeKey,
          workspaceActive: true,
          activationRevision: activationTracker.revisionByKey.get(activeKey) ?? 0,
          documentVisible,
          surfaceActive: true,
        }}>
          {outlet}
        </KeepAliveContext.Provider>
      )}
    </>
  );
};
