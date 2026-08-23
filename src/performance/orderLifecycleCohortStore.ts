import { useEffect, useSyncExternalStore } from 'react';

import { authSession } from '../api/authSession';
import { getLoadedRuntimeConfig } from '../config/runtimeConfig';
import {
  assignOrderLifecycleCohort,
  type OrderLifecycleCohort,
} from './orderLifecycleRollout';

interface CohortSnapshot {
  authKey: string;
  cohort: OrderLifecycleCohort;
  resolved: boolean;
}

const listeners = new Set<() => void>();
let snapshot: CohortSnapshot = { authKey: '', cohort: 'disabled', resolved: false };
let pending: { authKey: string; promise: Promise<OrderLifecycleCohort> } | null = null;

export function useOrderLifecycleCohort(): OrderLifecycleCohort {
  const authKey = useSyncExternalStore(authSession.subscribe, getCurrentAuthKey, getCurrentAuthKey);
  const cohort = useSyncExternalStore(subscribe, getCurrentCohort, getCurrentCohort);

  useEffect(() => {
    void resolveOrderLifecycleCohort();
  }, [authKey]);

  return cohort;
}

export function useOrderLifecycleCohortResolved(): boolean {
  const authKey = useSyncExternalStore(authSession.subscribe, getCurrentAuthKey, getCurrentAuthKey);
  const resolved = useSyncExternalStore(subscribe, getCurrentResolved, getCurrentResolved);

  useEffect(() => {
    void resolveOrderLifecycleCohort();
  }, [authKey]);

  return resolved;
}

export function getCurrentOrderLifecycleCohort(): OrderLifecycleCohort {
  return getCurrentCohort();
}

export function resolveOrderLifecycleCohort(): Promise<OrderLifecycleCohort> {
  const authKey = getCurrentAuthKey();
  if (snapshot.authKey === authKey && snapshot.resolved) {
    return Promise.resolve(snapshot.cohort);
  }
  if (pending?.authKey === authKey) return pending.promise;

  const userId = authSession.getUser()?.id;
  const token = authSession.getAccessToken();
  if (!userId || !token) {
    publish({ authKey, cohort: 'disabled', resolved: true });
    return Promise.resolve('disabled');
  }

  const promise = assignOrderLifecycleCohort(
    getLoadedRuntimeConfig()?.rollouts?.orderLifecycleV2,
    String(userId),
  ).then((cohort) => {
    if (getCurrentAuthKey() === authKey) {
      publish({ authKey, cohort, resolved: true });
    }
    return cohort;
  }).finally(() => {
    if (pending?.authKey === authKey) pending = null;
  });
  pending = { authKey, promise };
  return promise;
}

export function resetOrderLifecycleCohortStoreForTests(): void {
  snapshot = { authKey: '', cohort: 'disabled', resolved: false };
  pending = null;
  listeners.forEach((listener) => listener());
}

function getCurrentCohort(): OrderLifecycleCohort {
  return snapshot.authKey === getCurrentAuthKey() ? snapshot.cohort : 'disabled';
}

function getCurrentResolved(): boolean {
  return snapshot.authKey === getCurrentAuthKey() && snapshot.resolved;
}

function getCurrentAuthKey(): string {
  return [
    authSession.getAccessTokenVersion(),
    authSession.getSessionGeneration(),
    authSession.getUser()?.id ?? '',
  ].join(':');
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function publish(next: CohortSnapshot): void {
  snapshot = next;
  listeners.forEach((listener) => listener());
}
