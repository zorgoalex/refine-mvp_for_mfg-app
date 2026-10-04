import { useCallback, useState, useSyncExternalStore } from 'react';

import { authSession } from '../../api/authSession';
import { authStorage } from '../../utils/auth';

/**
 * Выбранный вид экрана, запомненный в браузере для текущего пользователя.
 * Недоступное хранилище (приватный режим, запрет сайта) не ломает экран:
 * выбор просто действует до перезагрузки.
 */
export function useStoredViewMode<T extends string>(
  storageKey: string,
  allowed: readonly T[],
  fallback: T,
): [T, (next: T) => void] {
  const userId = useSyncExternalStore(authSession.subscribe, getCurrentUserId, () => null);
  const fullKey = userId ? viewModeStorageKey(userId, storageKey) : null;
  const [overrides, setOverrides] = useState<Record<string, T>>({});

  const stored = fullKey ? overrides[fullKey] ?? readStoredViewMode(fullKey, allowed) : null;
  const mode = stored ?? fallback;

  const setMode = useCallback((next: T) => {
    if (!allowed.includes(next)) return;
    const key = fullKey ?? '__anonymous__';
    setOverrides((current) => ({ ...current, [key]: next }));
    if (fullKey) writeStoredViewMode(fullKey, next);
  }, [allowed, fullKey]);

  return [fullKey ? mode : overrides.__anonymous__ ?? fallback, setMode];
}

export function viewModeStorageKey(userId: string, storageKey: string): string {
  return `erp.viewMode.${userId}.${storageKey}`;
}

export function readStoredViewMode<T extends string>(fullKey: string, allowed: readonly T[]): T | null {
  try {
    const value = localStorage.getItem(fullKey);
    return value != null && (allowed as readonly string[]).includes(value) ? (value as T) : null;
  } catch {
    return null;
  }
}

function writeStoredViewMode(fullKey: string, value: string): void {
  try {
    localStorage.setItem(fullKey, value);
  } catch {
    // Хранилище недоступно — выбор действует только в текущей вкладке.
  }
}

function getCurrentUserId(): string | null {
  if (typeof localStorage === 'undefined') return null;
  const id = authSession.getUser()?.id ?? authStorage.getUser()?.id;
  return id == null ? null : String(id);
}
