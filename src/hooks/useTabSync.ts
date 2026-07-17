import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { useTabStore } from '../stores/tabStore';
import { resolveTabLabel, resourceFromPath, shouldPreserveTabLabel } from '../utils/tabLabels';

const IGNORED = new Set(['/', '/login']);

export const useTabSync = (): void => {
  const location = useLocation();
  const openTab = useTabStore((s) => s.openTab);
  useEffect(() => {
    if (IGNORED.has(location.pathname)) return; // phantom-tab guard
    openTab({
      key: location.pathname,
      path: `${location.pathname}${location.search}`,
      label: resolveTabLabel(location.pathname),
      resource: resourceFromPath(location.pathname) ?? location.pathname,
      preserveLabel: shouldPreserveTabLabel(location.pathname),
    });
  }, [location.pathname, location.search, openTab]);
};
