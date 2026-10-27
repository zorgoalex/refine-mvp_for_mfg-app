import { authSession } from './authSession';
import { mdfCorrectionApi, type MdfEngineModeDto } from './mdfCorrectionApi';
import { mdfPublishedApi } from './mdfPublishedApi';
import type { MdfSessionSnapshot } from './types/mdfPublishedApi.types';

/** Opening the MDF board directly (reload, bookmark) starts its engine-mode and snapshot reads as soon as the session is
 * known, instead of after the workspace shell and the page have mounted. The board's first cycle takes them once. */
const MAX_AGE_MS = 20_000;

interface Prefetch<T> { key: string; sessionGeneration: number; createdAt: number; promise: Promise<T> }

let engineMode: Prefetch<MdfEngineModeDto> | null = null;
let published: Prefetch<MdfSessionSnapshot> | null = null;

const publishedKey = (dateTo: string, displayFrom: string) => `${dateTo}|${displayFrom}`;

function fresh<T>(entry: Prefetch<T> | null, key: string): entry is Prefetch<T> {
  return Boolean(entry && entry.key === key && entry.sessionGeneration === authSession.getSessionGeneration()
    && Date.now() - entry.createdAt <= MAX_AGE_MS);
}

function start<T>(key: string, read: () => Promise<T>): Prefetch<T> {
  const promise = read();
  promise.catch(() => undefined);
  return { key, sessionGeneration: authSession.getSessionGeneration(), createdAt: Date.now(), promise };
}

export function prefetchMdfBoardOpen(query: { dateTo: string; displayFrom: string }): void {
  if (!fresh(engineMode, 'mode')) engineMode = start('mode', () => mdfCorrectionApi.getEngineMode());
  const key = publishedKey(query.dateTo, query.displayFrom);
  if (!fresh(published, key)) published = start(key, () => mdfPublishedApi.get(query));
}

/** The prefetched engine mode, once; a failed prefetch is read again. */
export function takePrefetchedMdfEngineMode(): Promise<MdfEngineModeDto> | null {
  if (!fresh(engineMode, 'mode')) return null;
  const { promise } = engineMode;
  engineMode = null;
  return promise.catch(() => mdfCorrectionApi.getEngineMode());
}

/** The prefetched snapshot of exactly this default query (no focus, no extra orders), once. */
export function takePrefetchedMdfSnapshot(query: { dateTo: string; displayFrom: string }): Promise<MdfSessionSnapshot> | null {
  if (!fresh(published, publishedKey(query.dateTo, query.displayFrom))) return null;
  const { promise } = published;
  published = null;
  return promise.catch(() => mdfPublishedApi.get(query));
}
