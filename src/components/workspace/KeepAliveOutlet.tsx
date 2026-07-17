import React, { useRef } from 'react';
import { useOutlet, useLocation } from 'react-router-dom';
import { useTabStore } from '../../stores/tabStore';
import { isKeepAliveEligible, nextKeepAliveCache } from './keepAlive';
import { KeepAliveContext } from './KeepAliveContext';

export const KeepAliveOutlet: React.FC = () => {
  const outlet = useOutlet();
  const location = useLocation();
  const tabs = useTabStore((s) => s.tabs);
  const activeKey = location.pathname;
  const cacheRef = useRef<Map<string, React.ReactNode>>(new Map());

  const activeTab = tabs.find((t) => t.key === activeKey);
  const eligible = activeTab ? isKeepAliveEligible(activeKey, { dirty: activeTab.dirty }) : false;

  if (eligible && outlet) cacheRef.current.set(activeKey, outlet);

  // Evict per policy.
  const keep = nextKeepAliveCache(new Set(cacheRef.current.keys()), { activeKey, tabs });
  for (const key of Array.from(cacheRef.current.keys())) {
    if (!keep.has(key)) cacheRef.current.delete(key);
  }

  return (
    <>
      {Array.from(cacheRef.current.entries()).map(([key, node]) => (
        <KeepAliveContext.Provider key={key} value={{ isActive: key === activeKey, tabKey: key }}>
          <div hidden={key !== activeKey}>{node}</div>
        </KeepAliveContext.Provider>
      ))}
      {!eligible && (
        <KeepAliveContext.Provider value={{ isActive: true, tabKey: activeKey }}>
          {outlet}
        </KeepAliveContext.Provider>
      )}
    </>
  );
};
