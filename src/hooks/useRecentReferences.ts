import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { profileApi } from '../api/profileApi';
import type {
  RecentReferenceResource,
  RecentReferences,
} from '../api/types/profileApi.types';
import { RECENT_REFERENCE_RESOURCES } from '../api/types/profileApi.types';
import { authStorage } from '../utils/auth';

export class FollowUpRefreshCoordinator {
  private readonly pending = new Map<string, Promise<void>>();
  private readonly followUpUsers = new Set<string>();

  run(
    userId: string,
    load: () => Promise<void>,
    requestFollowUp = false,
  ): Promise<void> {
    const existing = this.pending.get(userId);
    if (existing) {
      if (requestFollowUp) this.followUpUsers.add(userId);
      return existing;
    }

    const request = load().finally(() => {
      if (this.pending.get(userId) !== request) return;
      this.pending.delete(userId);
      if (this.followUpUsers.delete(userId)) {
        void this.run(userId, load);
      }
    });
    this.pending.set(userId, request);
    return request;
  }
}

const EMPTY_IDS: number[] = [];
const MAX_RECENT_IDS = 20;
const channelName = 'erp-reference-recency';
const recentReferenceResourceSet = new Set<string>(RECENT_REFERENCE_RESOURCES);

const recentByUser = new Map<string, RecentReferences>();
const listenersByUser = new Map<string, Set<() => void>>();
const requestQueues = new Map<string, Promise<void>>();
const revisionsByUser = new Map<string, number>();
const refreshCoordinator = new FollowUpRefreshCoordinator();
let channel: BroadcastChannel | null = null;

export interface RecentReferenceOption {
  value: number;
  label: string;
  sortOrder?: number | null;
}

export function sortOptionsByRecency<T extends RecentReferenceOption>(
  options: readonly T[],
  recentIds: readonly number[],
): T[] {
  const rank = new Map(recentIds.map((id, index) => [id, index]));
  return [...options].sort((left, right) => {
    const leftRank = rank.get(left.value);
    const rightRank = rank.get(right.value);
    if (leftRank !== undefined || rightRank !== undefined) {
      if (leftRank === undefined) return 1;
      if (rightRank === undefined) return -1;
      if (leftRank !== rightRank) return leftRank - rightRank;
    }
    const sortOrderDelta = (left.sortOrder ?? 100) - (right.sortOrder ?? 100);
    if (sortOrderDelta !== 0) return sortOrderDelta;
    const labelDelta = left.label.localeCompare(right.label, 'ru');
    return labelDelta || left.value - right.value;
  });
}

export function useRecentReferences(resource: RecentReferenceResource) {
  const userId = getCurrentUserId();
  const recentIds = useSyncExternalStore(
    useCallback((listener) => subscribe(userId, listener), [userId]),
    useCallback(() => getRecentIds(userId, resource), [resource, userId]),
    () => EMPTY_IDS,
  );

  useEffect(() => {
    if (!userId) return;
    ensureChannel();
    void refreshPreferences(userId);

    const onFocus = () => {
      if (getCurrentUserId() === userId) void refreshPreferences(userId, true);
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [userId]);

  const promote = useCallback((entityId: number) => {
    if (!userId || !Number.isSafeInteger(entityId) || entityId < 1) return;
    const revision = promoteOptimistically(userId, resource, entityId);
    enqueuePromotion(userId, resource, entityId, revision);
  }, [resource, userId]);

  return { recentIds, promote };
}

function getCurrentUserId(): string | null {
  const id = authStorage.getUser()?.id;
  return id == null ? null : String(id);
}

function getRecentIds(
  userId: string | null,
  resource: RecentReferenceResource,
): number[] {
  if (!userId) return EMPTY_IDS;
  return recentByUser.get(userId)?.[resource] ?? EMPTY_IDS;
}

function subscribe(userId: string | null, listener: () => void): () => void {
  if (!userId) return () => undefined;
  const listeners = listenersByUser.get(userId) ?? new Set<() => void>();
  listeners.add(listener);
  listenersByUser.set(userId, listeners);
  return () => listeners.delete(listener);
}

function publish(userId: string): void {
  listenersByUser.get(userId)?.forEach((listener) => listener());
}

function setRecentReferences(userId: string, value: unknown): void {
  recentByUser.set(userId, normalizeRecentReferences(value));
  publish(userId);
}

function promoteOptimistically(
  userId: string,
  resource: RecentReferenceResource,
  entityId: number,
): number {
  const current = recentByUser.get(userId) ?? {};
  const ids = [entityId, ...(current[resource] ?? []).filter((id) => id !== entityId)]
    .slice(0, MAX_RECENT_IDS);
  recentByUser.set(userId, { ...current, [resource]: ids });
  const revision = (revisionsByUser.get(userId) ?? 0) + 1;
  revisionsByUser.set(userId, revision);
  publish(userId);
  return revision;
}

function enqueuePromotion(
  userId: string,
  resource: RecentReferenceResource,
  entityId: number,
  revision: number,
): void {
  let refreshAfterFailure = false;
  const queued = (requestQueues.get(userId) ?? Promise.resolve())
    .then(async () => {
      if (getCurrentUserId() !== userId) return;
      const response = await profileApi.promoteReferenceUsage({ resource, entityId });
      if (!shouldApplyRecentResponse(
        userId,
        getCurrentUserId(),
        revision,
        revisionsByUser.get(userId) ?? 0,
      )) return;
      setRecentReferences(userId, response.preferences.recentReferences);
      ensureChannel()?.postMessage({ type: 'invalidate', userId });
    })
    .catch(() => {
      refreshAfterFailure = getCurrentUserId() === userId;
    })
    .finally(() => {
      if (requestQueues.get(userId) !== queued) return;
      requestQueues.delete(userId);
      if (refreshAfterFailure) void refreshPreferences(userId);
    });
  requestQueues.set(userId, queued);
}

function refreshPreferences(userId: string, requestFollowUp = false): Promise<void> {
  return refreshCoordinator.run(
    userId,
    () => loadPreferences(userId, requestFollowUp),
    requestFollowUp,
  );
}

async function loadPreferences(userId: string, force = false): Promise<void> {
  if (getCurrentUserId() !== userId) return;
  const revision = revisionsByUser.get(userId) ?? 0;
  const hadPendingPromotion = requestQueues.has(userId);
  await profileApi.getPreferences({ force })
    .then((response) => {
      if (!shouldApplyLoadedRecentResponse(
        userId,
        getCurrentUserId(),
        revision,
        revisionsByUser.get(userId) ?? 0,
        hadPendingPromotion,
      )) return;
      setRecentReferences(userId, response.preferences.recentReferences);
    })
    .catch(() => undefined);
}

export function shouldApplyRecentResponse(
  expectedUserId: string,
  currentUserId: string | null,
  requestRevision: number,
  currentRevision: number,
): boolean {
  return currentUserId === expectedUserId && requestRevision === currentRevision;
}

export function shouldApplyLoadedRecentResponse(
  expectedUserId: string,
  currentUserId: string | null,
  requestRevision: number,
  currentRevision: number,
  hadPendingPromotion: boolean,
): boolean {
  return !hadPendingPromotion && shouldApplyRecentResponse(
    expectedUserId,
    currentUserId,
    requestRevision,
    currentRevision,
  );
}

function ensureChannel(): BroadcastChannel | null {
  if (channel || typeof BroadcastChannel === 'undefined') return channel;
  channel = new BroadcastChannel(channelName);
  channel.addEventListener('message', (event: MessageEvent) => {
    const userId = getCurrentUserId();
    if (!shouldRefreshRecentReferences(event.data, userId)) return;
    void refreshPreferences(userId, true);
  });
  return channel;
}

export function shouldRefreshRecentReferences(
  message: unknown,
  currentUserId: string | null,
): currentUserId is string {
  if (!currentUserId || !message || typeof message !== 'object') return false;
  const candidate = message as { type?: unknown; userId?: unknown };
  return candidate.type === 'invalidate' && String(candidate.userId ?? '') === currentUserId;
}

export function normalizeRecentReferences(value: unknown): RecentReferences {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const normalized: RecentReferences = {};
  for (const [resource, rawIds] of Object.entries(value as Record<string, unknown>)) {
    if (!recentReferenceResourceSet.has(resource) || !Array.isArray(rawIds)) continue;
    const ids = [...new Set(
      rawIds.filter((id): id is number => Number.isSafeInteger(id) && Number(id) > 0),
    )].slice(0, MAX_RECENT_IDS);
    normalized[resource as RecentReferenceResource] = ids;
  }
  return normalized;
}
