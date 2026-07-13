import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { profileApi } from '../api/profileApi';
import { authSession } from '../api/authSession';
import { authStorage } from '../utils/auth';
import { getStoredThemeMode, getStoredUiSize, setStoredThemeMode, setStoredUiSize } from './themeStorage';
import type { ThemeMode, UiSize } from './themeTypes';

interface AppThemeContextValue {
  mode: ThemeMode;
  uiSize: UiSize;
  setMode: (mode: ThemeMode) => Promise<void>;
  setUiSize: (size: UiSize) => Promise<void>;
  toggleMode: () => Promise<void>;
}

const AppThemeContext = createContext<AppThemeContextValue | null>(null);

export const AppThemeProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
  const [authRevision, setAuthRevision] = useState(0);
  const [mode, setModeState] = useState<ThemeMode>(() => {
    const userId = getCurrentUserId();
    return (userId ? getStoredThemeMode(String(userId)) : null) ?? 'light';
  });
  const [uiSize, setUiSizeState] = useState<UiSize>(() => {
    const userId = getCurrentUserId();
    return (userId ? getStoredUiSize(String(userId)) : null) ?? 'default';
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
    const cachedSize = userId ? getStoredUiSize(String(userId)) : null;
    if (cachedSize) {
      setUiSizeState(cachedSize);
    }

    let active = true;
    profileApi.getPreferences()
      .then((response) => {
        if (!active) return;
        setModeState(response.preferences.themeMode);
        setUiSizeState(response.preferences.uiSize);
        const refreshedUserId = getCurrentUserId();
        if (refreshedUserId) {
          setStoredThemeMode(refreshedUserId, response.preferences.themeMode);
          setStoredUiSize(refreshedUserId, response.preferences.uiSize);
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

  const setUiSize = useCallback(async (nextSize: UiSize) => {
    const token = authStorage.getAccessToken();
    const userId = getCurrentUserId();
    setUiSizeState(nextSize);
    if (userId) {
      setStoredUiSize(String(userId), nextSize);
    }

    if (!token || !userId) return;

    try {
      const response = await profileApi.updatePreferences({ uiSize: nextSize });
      setUiSizeState(response.preferences.uiSize);
      const refreshedUserId = getCurrentUserId() ?? userId;
      if (refreshedUserId) {
        setStoredUiSize(refreshedUserId, response.preferences.uiSize);
      }
    } catch {
      // Optimistic local preference; backend retried on next explicit change.
    }
  }, []);

  const toggleMode = useCallback(
    () => setMode(mode === 'dark' ? 'light' : 'dark'),
    [mode, setMode],
  );

  const value = useMemo<AppThemeContextValue>(
    () => ({ mode, uiSize, setMode, setUiSize, toggleMode }),
    [mode, uiSize, setMode, setUiSize, toggleMode],
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
