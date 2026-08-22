import { authSession } from '../api/authSession';
import { subscribeOrderFormReferencesChanged } from '../api/orderFormReferenceEvents';
import { ordersApi } from '../api/ordersApi';
import type { OrderFormDataResponse } from '../api/types/orderApi.types';
import { getAuthCacheNamespace } from './authCacheNamespace';
import {
  EMPTY_ORDER_FORM_DATA_REFERENCES,
  mapOrderFormDataToReferences,
  type OrderFormDataReferences,
} from './orderFormDataReferences';

export const ORDER_FORM_DATA_STALE_TIME_MS = 60_000;
export const ORDER_FORM_DATA_BACKEND_MODE = 'backend-order-form-data';

export type OrderFormDataResourceStatus = 'idle' | 'loading' | 'refreshing' | 'ready' | 'error';

export interface OrderFormDataResourceSnapshot {
  namespace: string;
  data: OrderFormDataResponse | null;
  normalizedReferences: OrderFormDataReferences;
  revision: number;
  fetchedAt: number;
  status: OrderFormDataResourceStatus;
  error: Error | null;
  inFlight: boolean;
  generation: number;
}

interface ResourceEntry {
  snapshot: OrderFormDataResourceSnapshot;
  stale: boolean;
  promise: Promise<OrderFormDataResponse> | null;
  controller: AbortController | null;
  activationDecision: {
    revision: number;
    refreshRequired: boolean;
  };
  activeReaders: number;
  inactiveAbortToken: object | null;
  externalAbortCleanups: Set<() => void> | null;
}

export interface OrderFormDataResourceDiagnostics {
  requestCount: number;
  normalizationCount: number;
  referenceOwnerCount: number;
  subscriberCount: number;
  activeReaderCount: number;
}

const entries = new Map<string, ResourceEntry>();
const listeners = new Set<() => void>();
let generation = 0;
let requestCount = 0;
let normalizationCount = 0;
let stopReferenceOwner: (() => void) | null = null;

authSession.subscribeBeforeClear(() => {
  clearOrderFormDataCache();
});

export function getCurrentOrderFormDataNamespace(): string {
  return getAuthCacheNamespace(ORDER_FORM_DATA_BACKEND_MODE);
}

export function subscribeOrderFormDataResource(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function retainOrderFormDataRead(
  namespace = getCurrentOrderFormDataNamespace(),
): () => void {
  const entry = getOrCreateEntry(namespace);
  entry.activeReaders += 1;
  entry.inactiveAbortToken = null;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (entries.get(namespace) !== entry) return;
    entry.activeReaders = Math.max(0, entry.activeReaders - 1);
    if (entry.activeReaders !== 0) return;
    const token = {};
    entry.inactiveAbortToken = token;
    queueMicrotask(() => {
      if (
        entries.get(namespace) !== entry
        || entry.activeReaders !== 0
        || entry.inactiveAbortToken !== token
      ) return;
      entry.inactiveAbortToken = null;
      abortOrderFormDataEntry(entry);
    });
  };
}

export function getOrderFormDataResourceSnapshot(
  namespace = getCurrentOrderFormDataNamespace(),
): OrderFormDataResourceSnapshot {
  return getOrCreateEntry(namespace).snapshot;
}

export function getCachedOrderFormData(
  namespace = getCurrentOrderFormDataNamespace(),
): OrderFormDataResponse | null {
  return getOrCreateEntry(namespace).snapshot.data;
}

export function isOrderFormDataCacheStale(
  namespace = getCurrentOrderFormDataNamespace(),
): boolean {
  return isEntryStale(getOrCreateEntry(namespace));
}

export function getOrderFormDataCacheGeneration(
  namespace = getCurrentOrderFormDataNamespace(),
): number {
  return getOrCreateEntry(namespace).snapshot.generation;
}

export function getOrderFormDataResourceDiagnostics(): OrderFormDataResourceDiagnostics {
  return {
    requestCount,
    normalizationCount,
    referenceOwnerCount: stopReferenceOwner ? 1 : 0,
    subscriberCount: listeners.size,
    activeReaderCount: Array.from(entries.values())
      .reduce((total, entry) => total + entry.activeReaders, 0),
  };
}

export function resetOrderFormDataCacheForTests(): void {
  abortEntries();
  entries.clear();
  listeners.clear();
  generation += 1;
  requestCount = 0;
  normalizationCount = 0;
  stopReferenceOwner?.();
  stopReferenceOwner = null;
  emit();
}

export function prepareOrderFormDataActivationRefresh(
  activationRevision: number,
  namespace = getCurrentOrderFormDataNamespace(),
): {
  refreshRequired: boolean;
  ownsRefresh: boolean;
} {
  const entry = getOrCreateEntry(namespace);
  if (entry.activationDecision.revision === activationRevision) {
    return {
      refreshRequired: entry.activationDecision.refreshRequired,
      ownsRefresh: false,
    };
  }

  const refreshRequired = !entry.snapshot.inFlight && isEntryStale(entry);
  entry.activationDecision = { revision: activationRevision, refreshRequired };
  if (refreshRequired) invalidateOrderFormDataCache(namespace);
  return { refreshRequired, ownsRefresh: refreshRequired };
}

export function invalidateOrderFormDataCache(
  namespace = getCurrentOrderFormDataNamespace(),
): void {
  const entry = getOrCreateEntry(namespace);
  clearExternalAbortOwners(entry.externalAbortCleanups);
  entry.externalAbortCleanups = null;
  entry.controller?.abort();
  entry.controller = null;
  entry.promise = null;
  entry.stale = true;
  generation += 1;
  entry.snapshot = {
    ...entry.snapshot,
    generation,
    status: entry.snapshot.data ? 'ready' : 'idle',
    error: null,
    inFlight: false,
  };
  emit();
}

export function clearOrderFormDataCache(): void {
  abortEntries();
  entries.clear();
  generation += 1;
  emit();
}

export function prefetchOrderFormData(
  namespace = getCurrentOrderFormDataNamespace(),
  options: { signal?: AbortSignal } = {},
): Promise<OrderFormDataResponse> {
  ensureReferenceOwner();
  const entry = getOrCreateEntry(namespace);
  if (entry.promise) {
    attachExternalAbortOwner(entry, options.signal);
    return entry.promise;
  }
  if (entry.snapshot.data && !isEntryStale(entry)) {
    return Promise.resolve(entry.snapshot.data);
  }

  const requestGeneration = entry.snapshot.generation;
  const controller = new AbortController();
  const externalAbortCleanups = new Set<() => void>();
  entry.controller = controller;
  entry.externalAbortCleanups = externalAbortCleanups;
  requestCount += 1;
  entry.snapshot = {
    ...entry.snapshot,
    status: entry.snapshot.data ? 'refreshing' : 'loading',
    error: null,
    inFlight: true,
  };
  emit();

  const request = ordersApi
    .getFormData({ signal: controller.signal })
    .then((response) => {
      if (!isCurrentEntry(namespace, entry, requestGeneration)) return response;
      const normalizedReferences = mapOrderFormDataToReferences(response);
      normalizationCount += 1;
      entry.stale = false;
      entry.snapshot = {
        ...entry.snapshot,
        data: response,
        normalizedReferences,
        revision: entry.snapshot.revision + 1,
        fetchedAt: Date.now(),
        status: 'ready',
        error: null,
        inFlight: false,
      };
      emit();
      return response;
    })
    .catch((unknownError) => {
      if (isCurrentEntry(namespace, entry, requestGeneration)) {
        entry.snapshot = {
          ...entry.snapshot,
          status: 'error',
          error: toError(unknownError),
          inFlight: false,
        };
        emit();
      }
      throw unknownError;
    })
    .finally(() => {
      clearExternalAbortOwners(externalAbortCleanups);
      if (entry.externalAbortCleanups === externalAbortCleanups) {
        entry.externalAbortCleanups = null;
      }
      if (entry.promise === request) entry.promise = null;
      if (entry.controller === controller) entry.controller = null;
    });
  entry.promise = request;
  attachExternalAbortOwner(entry, options.signal);
  return request;
}

function getOrCreateEntry(namespace: string): ResourceEntry {
  const existing = entries.get(namespace);
  if (existing) return existing;
  const entry: ResourceEntry = {
    snapshot: {
      namespace,
      data: null,
      normalizedReferences: EMPTY_ORDER_FORM_DATA_REFERENCES,
      revision: 0,
      fetchedAt: 0,
      status: 'idle',
      error: null,
      inFlight: false,
      generation,
    },
    stale: false,
    promise: null,
    controller: null,
    activationDecision: { revision: -1, refreshRequired: false },
    activeReaders: 0,
    inactiveAbortToken: null,
    externalAbortCleanups: null,
  };
  entries.set(namespace, entry);
  return entry;
}

function isEntryStale(entry: ResourceEntry): boolean {
  return entry.stale
    || (
      entry.snapshot.data !== null
      && Date.now() - entry.snapshot.fetchedAt >= ORDER_FORM_DATA_STALE_TIME_MS
    );
}

function isCurrentEntry(
  namespace: string,
  entry: ResourceEntry,
  requestGeneration: number,
): boolean {
  return entries.get(namespace) === entry
    && entry.snapshot.generation === requestGeneration;
}

function abortEntries(): void {
  entries.forEach((entry) => {
    entry.inactiveAbortToken = null;
    clearExternalAbortOwners(entry.externalAbortCleanups);
    entry.externalAbortCleanups = null;
    entry.controller?.abort();
  });
}

function abortOrderFormDataEntry(entry: ResourceEntry): void {
  if (!entry.controller && !entry.snapshot.inFlight) return;
  entry.controller?.abort();
  entry.controller = null;
  entry.promise = null;
  clearExternalAbortOwners(entry.externalAbortCleanups);
  entry.externalAbortCleanups = null;
  generation += 1;
  entry.snapshot = {
    ...entry.snapshot,
    generation,
    status: entry.snapshot.data ? 'ready' : 'idle',
    error: null,
    inFlight: false,
  };
  emit();
}

function attachExternalAbortOwner(entry: ResourceEntry, signal?: AbortSignal): void {
  if (!signal || !entry.controller || !entry.externalAbortCleanups) return;
  const controller = entry.controller;
  const cleanups = entry.externalAbortCleanups;
  const onAbort = () => {
    if (entry.activeReaders === 0 && entry.controller === controller) {
      abortOrderFormDataEntry(entry);
    }
  };
  const cleanup = () => signal.removeEventListener('abort', onAbort);
  cleanups.add(cleanup);
  signal.addEventListener('abort', onAbort, { once: true });
  if (signal.aborted) onAbort();
}

function clearExternalAbortOwners(cleanups: Set<() => void> | null): void {
  cleanups?.forEach((cleanup) => cleanup());
  cleanups?.clear();
}

function ensureReferenceOwner(): void {
  if (stopReferenceOwner) return;
  stopReferenceOwner = subscribeOrderFormReferencesChanged(() => {
    invalidateOrderFormDataCache(getCurrentOrderFormDataNamespace());
  });
}

function emit(): void {
  listeners.forEach((listener) => listener());
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error('Failed to load order form data');
}
