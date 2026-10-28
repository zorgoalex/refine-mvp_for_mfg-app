import { authSession } from './authSession';
import { mdfCorrectionApi, type MdfEngineModeDto } from './mdfCorrectionApi';
import { mdfPublishedApi } from './mdfPublishedApi';
import type { MdfSessionSnapshot } from './types/mdfPublishedApi.types';

/** Opening the MDF board directly (reload, bookmark), or a recent board user signing in, starts its engine-mode and
 * snapshot reads as soon as the session is known, instead of after the workspace shell and the page have mounted. The
 * board's first cycle takes them once: up to MAX_AGE_MS old they are shown at once, and older than FRESH_MS the board
 * reads again right after showing them. */
const MAX_AGE_MS = 5 * 60_000;
const FRESH_MS = 20_000;

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
  if (!fresh(engineMode, 'mode')) {
    engineMode = start('mode', () => mdfCorrectionApi.getEngineMode());
    modePeeked = false;
  }
  const key = publishedKey(query.dateTo, query.displayFrom);
  if (!fresh(published, key)) published = start(key, () => mdfPublishedApi.get(query));
}

/** False when what the board would take now is older than FRESH_MS (the board then refreshes after showing it). */
export function mdfBoardOpenPrefetchFresh(now = Date.now()): boolean {
  return [engineMode, published].every((entry) => !entry || now - entry.createdAt <= FRESH_MS);
}

/** The prefetched engine mode; a failed prefetch is read again. Taken for good together with the snapshot: while the
 * snapshot is still waiting for its own query (the board's first cycle may run on a default period before the page
 * restores the user's one), one cycle may use the mode without consuming it. */
let modePeeked = false;
export function takePrefetchedMdfEngineMode(): Promise<MdfEngineModeDto> | null {
  if (!fresh(engineMode, 'mode')) return null;
  const { promise } = engineMode;
  const snapshotWaiting = published !== null && fresh(published, published.key);
  if (snapshotWaiting && !modePeeked) {
    modePeeked = true;
  } else {
    engineMode = null;
    modePeeked = false;
  }
  return promise.catch(() => mdfCorrectionApi.getEngineMode());
}

/** The prefetched snapshot of exactly this default query (no focus, no extra orders), once. */
export function takePrefetchedMdfSnapshot(query: { dateTo: string; displayFrom: string }): Promise<MdfSessionSnapshot> | null {
  if (!fresh(published, publishedKey(query.dateTo, query.displayFrom))) return null;
  const { promise } = published;
  published = null;
  return promise.catch(() => mdfPublishedApi.get(query));
}
