import { useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { resolveTabOpenerKey, syncWorkspaceTabsForCurrentUser, useTabStore } from '../stores/tabStore';
import { resolveTabLabel, resourceFromPath, shouldPreserveTabLabel } from '../utils/tabLabels';

const IGNORED = new Set(['/', '/login']);

export const useTabSync = (): void => {
  const location = useLocation();
  const openTab = useTabStore((s) => s.openTab);
  const previousTabKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (IGNORED.has(location.pathname)) {
      previousTabKeyRef.current = null;
      return; // phantom-tab guard
    }
    syncWorkspaceTabsForCurrentUser();
    const tabsBeforeOpen = useTabStore.getState().tabs;
    const openerKey = resolveTabOpenerKey(tabsBeforeOpen, location.pathname, previousTabKeyRef.current);
    openTab({
      key: location.pathname,
      path: `${location.pathname}${location.search}`,
      label: resolveTabLabel(location.pathname),
      resource: resourceFromPath(location.pathname) ?? location.pathname,
      openerKey,
      preserveLabel: shouldPreserveTabLabel(location.pathname),
    });
    previousTabKeyRef.current = location.pathname;
  }, [location.pathname, location.search, openTab]);
};
