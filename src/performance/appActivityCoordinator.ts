import { useEffect, useSyncExternalStore } from 'react';

export const APP_ACTIVITY_COALESCE_MS = 50;

export interface AppActivitySnapshot {
  activationRevision: number;
  documentVisible: boolean;
  windowFocused: boolean;
}

export interface AppActivityDiagnostics {
  coordinatorOwnerCount: number;
  domListenerCount: number;
  refreshTriggerCount: number;
  subscriberCount: number;
}

type Listener = () => void;

const listeners = new Set<Listener>();
const diagnosticsListeners = new Set<(diagnostics: AppActivityDiagnostics) => void>();

let snapshot = readBrowserSnapshot(0);
let ownerCount = 0;
let listenersAttached = false;
let activationTimer: ReturnType<typeof setTimeout> | null = null;
let refreshTriggerCount = 0;

export function AppActivityCoordinatorBridge(): null {
  useEffect(() => startAppActivityCoordinator(), []);
  return null;
}

export function useAppActivitySnapshot(): AppActivitySnapshot {
  return useSyncExternalStore(subscribe, getAppActivitySnapshot, getServerSnapshot);
}

export function getAppActivitySnapshot(): AppActivitySnapshot {
  return snapshot;
}

export function getAppActivityDiagnostics(): AppActivityDiagnostics {
  return {
    coordinatorOwnerCount: ownerCount,
    domListenerCount: listenersAttached ? 3 : 0,
    refreshTriggerCount,
    subscriberCount: listeners.size,
  };
}

export function subscribeAppActivityDiagnostics(
  listener: (diagnostics: AppActivityDiagnostics) => void,
): () => void {
  diagnosticsListeners.add(listener);
  return () => diagnosticsListeners.delete(listener);
}

export function recordAppActivityRefreshTrigger(): void {
  refreshTriggerCount += 1;
  emitDiagnostics();
}

export function startAppActivityCoordinator(): () => void {
  ownerCount += 1;
  if (ownerCount === 1) attachBrowserListeners();
  emitDiagnostics();
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    ownerCount = Math.max(0, ownerCount - 1);
    if (ownerCount === 0) detachBrowserListeners();
    emitDiagnostics();
  };
}

export function resetAppActivityCoordinatorForTests(): void {
  ownerCount = 0;
  detachBrowserListeners();
  listeners.clear();
  diagnosticsListeners.clear();
  refreshTriggerCount = 0;
  snapshot = readBrowserSnapshot(0);
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  emitDiagnostics();
  return () => {
    listeners.delete(listener);
    emitDiagnostics();
  };
}

function getServerSnapshot(): AppActivitySnapshot {
  return {
    activationRevision: 0,
    documentVisible: true,
    windowFocused: true,
  };
}

function attachBrowserListeners(): void {
  if (listenersAttached || typeof window === 'undefined' || typeof document === 'undefined') return;
  listenersAttached = true;
  snapshot = readBrowserSnapshot(snapshot.activationRevision);
  window.addEventListener('focus', handleFocus);
  window.addEventListener('blur', handleBlur);
  document.addEventListener('visibilitychange', handleVisibilityChange);
  emitSnapshot();
}

function detachBrowserListeners(): void {
  cancelActivation();
  if (!listenersAttached || typeof window === 'undefined' || typeof document === 'undefined') {
    listenersAttached = false;
    return;
  }
  window.removeEventListener('focus', handleFocus);
  window.removeEventListener('blur', handleBlur);
  document.removeEventListener('visibilitychange', handleVisibilityChange);
  listenersAttached = false;
}

function handleFocus(): void {
  publishBaseSnapshot({ windowFocused: true });
  scheduleActivation();
}

function handleBlur(): void {
  cancelActivation();
  publishBaseSnapshot({ windowFocused: false });
}

function handleVisibilityChange(): void {
  const documentVisible = document.visibilityState !== 'hidden';
  if (!documentVisible) cancelActivation();
  publishBaseSnapshot({ documentVisible });
  if (documentVisible) scheduleActivation();
}

function publishBaseSnapshot(next: Partial<AppActivitySnapshot>): void {
  const candidate = { ...snapshot, ...next };
  if (
    candidate.documentVisible === snapshot.documentVisible
    && candidate.windowFocused === snapshot.windowFocused
  ) return;
  snapshot = candidate;
  emitSnapshot();
}

function scheduleActivation(): void {
  if (!snapshot.documentVisible || !snapshot.windowFocused || activationTimer !== null) return;
  activationTimer = setTimeout(() => {
    activationTimer = null;
    if (!snapshot.documentVisible || !snapshot.windowFocused) return;
    snapshot = { ...snapshot, activationRevision: snapshot.activationRevision + 1 };
    emitSnapshot();
  }, APP_ACTIVITY_COALESCE_MS);
}

function cancelActivation(): void {
  if (activationTimer === null) return;
  clearTimeout(activationTimer);
  activationTimer = null;
}

function emitSnapshot(): void {
  listeners.forEach((listener) => listener());
}

function emitDiagnostics(): void {
  const diagnostics = getAppActivityDiagnostics();
  diagnosticsListeners.forEach((listener) => listener(diagnostics));
}

function readBrowserSnapshot(activationRevision: number): AppActivitySnapshot {
  const documentVisible = typeof document === 'undefined' || document.visibilityState !== 'hidden';
  const windowFocused = typeof document === 'undefined'
    || typeof document.hasFocus !== 'function'
    || document.hasFocus();
  return { activationRevision, documentVisible, windowFocused };
}
