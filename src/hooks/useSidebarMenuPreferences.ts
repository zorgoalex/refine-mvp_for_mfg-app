import { useCallback, useEffect, useState } from 'react';
import { profileApi } from '../api/profileApi';
import type { SidebarMenuOrderPreference } from '../api/types/profileApi.types';

export const EMPTY_SIDEBAR_MENU_ORDER: SidebarMenuOrderPreference = {
  top: [],
  categories: [],
  resources: {},
};

export function useSidebarMenuPreferences() {
  const [settings, setSettings] = useState<SidebarMenuOrderPreference>(EMPTY_SIDEBAR_MENU_ORDER);

  useEffect(() => {
    let alive = true;
    profileApi.getPreferences()
      .then((response) => {
        if (!alive) return;
        setSettings(response.preferences.sidebarMenuOrder ?? EMPTY_SIDEBAR_MENU_ORDER);
      })
      .catch(() => {
        if (alive) setSettings(EMPTY_SIDEBAR_MENU_ORDER);
      });
    return () => {
      alive = false;
    };
  }, []);

  const saveSettings = useCallback(async (next: SidebarMenuOrderPreference) => {
    setSettings(next);
    const response = await profileApi.updatePreferences({ sidebarMenuOrder: next });
    setSettings(response.preferences.sidebarMenuOrder ?? next);
  }, []);

  return { settings, saveSettings };
}
