import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { profileApi } from '../api/profileApi';
import { authSession } from '../api/authSession';
import { authStorage } from '../utils/auth';
import { getStoredThemeMode, setStoredThemeMode } from './themeStorage';
import type { ThemeMode } from './themeTypes';

interface AppThemeContextValue {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => Promise<void>;
  toggleMode: () => Promise<void>;
}

const AppThemeContext = createContext<AppThemeContextValue | null>(null);

export const AppThemeProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
  const [authRevision, setAuthRevision] = useState(0);
  const [mode, setModeState] = useState<ThemeMode>(() => {
    const userId = getCurrentUserId();
    return (userId ? getStoredThemeMode(String(userId)) : null) ?? 'light';
  });

  useEffect(() => {
    document.documentElement.dataset.theme = mode;
  }, [mode]);

  useEffect(() => {
    return authSession.subscribe(() => {
      setAuthRevision((revision) => revision + 1);
    });
  }, []);

  useEffect(() => {
    const token = authStorage.getAccessToken();
    const userId = getCurrentUserId();
    if (!token || !userId) return;

    const cached = userId ? getStoredThemeMode(String(userId)) : null;
    if (cached) {
      setModeState(cached);
    }

    let active = true;
    profileApi.getPreferences()
      .then((response) => {
        if (!active) return;
        setModeState(response.preferences.themeMode);
        const refreshedUserId = getCurrentUserId();
        if (refreshedUserId) {
          setStoredThemeMode(refreshedUserId, response.preferences.themeMode);
        }
      })
      .catch(() => {
        // Theme falls back to cached/default value; auth error handling stays in httpClient.
      });

    return () => {
      active = false;
    };
  }, [authRevision]);

  const setMode = useCallback(async (nextMode: ThemeMode) => {
    const token = authStorage.getAccessToken();
    const userId = getCurrentUserId();
    setModeState(nextMode);
    if (userId) {
      setStoredThemeMode(String(userId), nextMode);
    }

    if (!token || !userId) return;

    try {
      const response = await profileApi.updatePreferences({ themeMode: nextMode });
      setModeState(response.preferences.themeMode);
      const refreshedUserId = getCurrentUserId() ?? userId;
      if (refreshedUserId) {
        setStoredThemeMode(refreshedUserId, response.preferences.themeMode);
      }
    } catch {
      // Keep optimistic local preference; backend will be retried on next explicit change.
    }
  }, []);

  const toggleMode = useCallback(
    () => setMode(mode === 'dark' ? 'light' : 'dark'),
    [mode, setMode],
  );

  const value = useMemo<AppThemeContextValue>(
    () => ({ mode, setMode, toggleMode }),
    [mode, setMode, toggleMode],
  );

  return (
    <AppThemeContext.Provider value={value}>
      <div data-theme={mode}>{children}</div>
    </AppThemeContext.Provider>
  );
};

function getCurrentUserId(): string | null {
  const id = authStorage.getUser()?.id;
  return id === undefined || id === null ? null : String(id);
}

export function useAppTheme(): AppThemeContextValue {
  const value = useContext(AppThemeContext);
  if (!value) {
    throw new Error('useAppTheme must be used inside AppThemeProvider');
  }
  return value;
}
