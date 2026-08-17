import { useCallback, useEffect, useRef, useState } from 'react';
import { profileApi } from '../api/profileApi';
import {
  loadSidebarCollapsed,
  saveSidebarCollapsed,
  type SidebarCollapsedUserId,
} from '../components/sidebarCollapsedPreference';

export function useSidebarCollapsedPreference(
  userId: SidebarCollapsedUserId,
  defaultCollapsed: boolean,
) {
  const [collapsed, setCollapsed] = useState(() => loadSidebarCollapsed(userId, defaultCollapsed));
  const preferenceRevisionRef = useRef(0);

  useEffect(() => {
    let alive = true;
    const loadRevision = preferenceRevisionRef.current;
    const fallbackCollapsed = loadSidebarCollapsed(userId, defaultCollapsed);
    setCollapsed(fallbackCollapsed);

    profileApi.getPreferences()
      .then((response) => {
        if (!alive || loadRevision !== preferenceRevisionRef.current) return;
        const serverCollapsed = response.preferences.sidebarCollapsed;
        if (typeof serverCollapsed === 'boolean') {
          setCollapsed(serverCollapsed);
          saveSidebarCollapsed(userId, serverCollapsed);
          return;
        }
        setCollapsed(fallbackCollapsed);
      })
      .catch(() => {
        if (alive) setCollapsed(fallbackCollapsed);
      });

    return () => {
      alive = false;
    };
  }, [defaultCollapsed, userId]);

  const saveCollapsed = useCallback((next: boolean) => {
    const saveRevision = preferenceRevisionRef.current + 1;
    preferenceRevisionRef.current = saveRevision;
    setCollapsed(next);
    saveSidebarCollapsed(userId, next);

    profileApi.updatePreferences({ sidebarCollapsed: next })
      .then((response) => {
        if (saveRevision !== preferenceRevisionRef.current) return;
        const serverCollapsed = response.preferences.sidebarCollapsed;
        if (typeof serverCollapsed !== 'boolean') return;
        setCollapsed(serverCollapsed);
        saveSidebarCollapsed(userId, serverCollapsed);
      })
      .catch(() => {
        // Keep the optimistic local preference when the profile endpoint is unavailable.
      });
  }, [userId]);

  return [collapsed, saveCollapsed] as const;
}
