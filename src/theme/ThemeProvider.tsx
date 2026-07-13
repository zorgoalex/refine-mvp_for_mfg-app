import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { profileApi } from '../api/profileApi';
import { authSession } from '../api/authSession';
import { authStorage } from '../utils/auth';
import { getStoredThemeMode, getStoredUiSize, isUiSize, setStoredThemeMode, setStoredUiSize } from './themeStorage';
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
    // Смена юзера в том же браузере: state обязан сброситься на кэш ИМЕННО
    // этого юзера (или default) — иначе новый юзер унаследует чужой компакт,
    // если старый backend (mixed deploy) не вернёт uiSize в ответе
    const cachedSize = userId ? getStoredUiSize(String(userId)) : null;
    setUiSizeState(cachedSize ?? 'default');

    let active = true;
    profileApi.getPreferences()
      .then((response) => {
        if (!active) return;
        setModeState(response.preferences.themeMode);
        // Окно смешанного деплоя: старый backend стрипает uiSize из ответа —
        // не затирать кэш/optimistic значение undefined'ом
        const responseSize = isUiSize(response.preferences.uiSize) ? response.preferences.uiSize : null;
        if (responseSize) {
          setUiSizeState(responseSize);
        }
        const refreshedUserId = getCurrentUserId();
        if (refreshedUserId) {
          setStoredThemeMode(refreshedUserId, response.preferences.themeMode);
          if (responseSize) {
            setStoredUiSize(refreshedUserId, responseSize);
          }
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
      // Старый backend может не вернуть uiSize (mixed deploy) — остаёмся на
      // optimistic-значении nextSize
      const confirmedSize = isUiSize(response.preferences.uiSize) ? response.preferences.uiSize : nextSize;
      setUiSizeState(confirmedSize);
      const refreshedUserId = getCurrentUserId() ?? userId;
      if (refreshedUserId) {
        setStoredUiSize(refreshedUserId, confirmedSize);
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
