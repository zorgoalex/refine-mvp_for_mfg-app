import { useCallback, useEffect, useSyncExternalStore } from 'react';

import { authSession } from '../api/authSession';
import { profileApi } from '../api/profileApi';
import type { PageSizePreferences } from '../api/types/profileApi.types';
import { authStorage } from '../utils/auth';

export const PAGE_SIZE_OPTIONS: number[] = [10, 20, 25, 50, 100];
export const DEFAULT_PAGE_SIZE = 10;

const allowedPageSizes = new Set<number>(PAGE_SIZE_OPTIONS);
const cacheByUser = new Map<string, PageSizePreferences>();
const listenersByUser = new Map<string, Set<() => void>>();
const loadedUsers = new Set<string>();
const loadsByUser = new Map<string, Promise<void>>();
const updateQueues = new Map<string, Promise<void>>();
const revisionsByUser = new Map<string, number>();
const channelName = 'erp-page-size-preferences';
let channel: BroadcastChannel | null = null;

export function usePageSizePreference(listKey: string, defaultPageSize = DEFAULT_PAGE_SIZE) {
  const userId = useSyncExternalStore(
    authSession.subscribe,
    getCurrentUserId,
    () => null,
  );
  const fallback = normalizePageSize(defaultPageSize) ?? DEFAULT_PAGE_SIZE;
  const pageSize = useSyncExternalStore(
    useCallback((listener) => subscribe(userId, listener), [userId]),
    useCallback(() => getPageSize(userId, listKey, fallback), [fallback, listKey, userId]),
    () => fallback,
  );

  useEffect(() => {
    if (!userId) return;
    ensureChannel();
    void loadPreferences(userId);

    const onFocus = () => {
      if (getCurrentUserId() === userId) void loadPreferences(userId, true);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [userId]);

  const setPageSize = useCallback((nextPageSize: number) => {
    const normalized = normalizePageSize(nextPageSize);
    if (!userId || !normalized || !isPreferenceKey(listKey)) return;

    const current = getCachedPreferences(userId);
    if (current[listKey] === normalized) return;
    const revision = (revisionsByUser.get(userId) ?? 0) + 1;
    revisionsByUser.set(userId, revision);
    setCachedPreferences(userId, { ...current, [listKey]: normalized });
    enqueueUpdate(userId, listKey, normalized, revision);
  }, [listKey, userId]);

  return { pageSize, setPageSize };
}

export function normalizePageSize(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && allowedPageSizes.has(value)
    ? value
    : null;
}

export function normalizePageSizePreferences(value: unknown): PageSizePreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

  const normalized: PageSizePreferences = {};
  for (const [rawKey, rawSize] of Object.entries(value as Record<string, unknown>)) {
    const key = rawKey.trim();
    const size = normalizePageSize(rawSize);
    if (isPreferenceKey(key) && size) normalized[key] = size;
  }
  return normalized;
}

export function pageSizeStorageKey(userId: string): string {
  return `erp.pageSizes.${userId}`;
}

function isPreferenceKey(value: string): boolean {
  return value.length > 0 && value.length <= 120;
}

function getCurrentUserId(): string | null {
  if (typeof localStorage === 'undefined') return null;
  const id = authSession.getUser()?.id ?? authStorage.getUser()?.id;
  return id == null ? null : String(id);
}

function getPageSize(userId: string | null, listKey: string, fallback: number): number {
  if (!userId || !isPreferenceKey(listKey)) return fallback;
  return getCachedPreferences(userId)[listKey] ?? fallback;
}

function getCachedPreferences(userId: string): PageSizePreferences {
  const cached = cacheByUser.get(userId);
  if (cached) return cached;

  let stored: PageSizePreferences = {};
  if (typeof localStorage !== 'undefined') {
    try {
      stored = normalizePageSizePreferences(JSON.parse(
        localStorage.getItem(pageSizeStorageKey(userId)) ?? '{}',
      ));
    } catch {
      stored = {};
    }
  }
  cacheByUser.set(userId, stored);
  return stored;
}

function setCachedPreferences(userId: string, preferences: PageSizePreferences): void {
  const normalized = normalizePageSizePreferences(preferences);
  cacheByUser.set(userId, normalized);
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(pageSizeStorageKey(userId), JSON.stringify(normalized));
  }
  listenersByUser.get(userId)?.forEach((listener) => listener());
}

function subscribe(userId: string | null, listener: () => void): () => void {
  if (!userId) return () => undefined;
  const listeners = listenersByUser.get(userId) ?? new Set<() => void>();
  listeners.add(listener);
  listenersByUser.set(userId, listeners);
  return () => listeners.delete(listener);
}

function loadPreferences(userId: string, force = false): Promise<void> {
  if (!force && loadedUsers.has(userId)) return Promise.resolve();
  const pending = loadsByUser.get(userId);
  if (pending) return pending;

  const revision = revisionsByUser.get(userId) ?? 0;
  const request = profileApi.getPreferences({ force })
    .then((response) => {
      if (getCurrentUserId() !== userId || response.preferences.pageSizePreferences === undefined) return;
      const server = normalizePageSizePreferences(response.preferences.pageSizePreferences);
      const current = getCachedPreferences(userId);
      const changedWhileLoading = (revisionsByUser.get(userId) ?? 0) !== revision;
      setCachedPreferences(
        userId,
        changedWhileLoading ? { ...server, ...current } : { ...current, ...server },
      );
      loadedUsers.add(userId);
    })
    .catch(() => undefined)
    .finally(() => {
      if (loadsByUser.get(userId) === request) loadsByUser.delete(userId);
    });
  loadsByUser.set(userId, request);
  return request;
}

function enqueueUpdate(
  userId: string,
  listKey: string,
  pageSize: number,
  requestRevision: number,
): void {
  const queued = (updateQueues.get(userId) ?? Promise.resolve())
    .then(async () => {
      if (getCurrentUserId() !== userId) return;
      const response = await profileApi.updatePreferences({
        pageSizePreferences: { [listKey]: pageSize },
      });
      if (getCurrentUserId() !== userId || response.preferences.pageSizePreferences === undefined) return;

      const server = normalizePageSizePreferences(response.preferences.pageSizePreferences);
      const current = getCachedPreferences(userId);
      const hasNewerOptimisticValue = (revisionsByUser.get(userId) ?? 0) !== requestRevision;
      setCachedPreferences(
        userId,
        hasNewerOptimisticValue ? { ...server, ...current } : { ...current, ...server },
      );
      loadedUsers.add(userId);
      ensureChannel()?.postMessage({ type: 'invalidate', userId });
    })
    .catch(() => {
      // Keep the optimistic local value; a later focus/change retries synchronization.
    })
    .finally(() => {
      if (updateQueues.get(userId) === queued) updateQueues.delete(userId);
    });
  updateQueues.set(userId, queued);
}

function ensureChannel(): BroadcastChannel | null {
  if (channel || typeof BroadcastChannel === 'undefined') return channel;
  channel = new BroadcastChannel(channelName);
  channel.addEventListener('message', (event: MessageEvent) => {
    const userId = getCurrentUserId();
    if (!userId || !event.data || typeof event.data !== 'object') return;
    const message = event.data as { type?: unknown; userId?: unknown };
    if (message.type === 'invalidate' && String(message.userId ?? '') === userId) {
      void loadPreferences(userId, true);
    }
  });
  return channel;
}
