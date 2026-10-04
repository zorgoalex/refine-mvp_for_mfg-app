import { createViewerState, viewerReduce, type ViewerEvent, type ViewerState } from './clientScreenArbiter';
import type { ClientScreenEnvironment } from './clientScreenEnvironment';
import { CLIENT_SCREEN_VIEWER_LOCK, clientScreenMessage, clientScreenOwnerLock } from './clientScreenProtocol';

/**
 * The customer window: runs the arbiter, watches the owner's lock, enforces the policy validity by
 * its own clock and obeys the workstation switch-off. It never calls the backend.
 */
export interface ClientScreenViewer {
  getState(): ViewerState;
  /** 'duplicate' — another customer window already holds the viewer lock; this one stays passive. */
  getRole(): 'starting' | 'viewer' | 'duplicate';
  subscribe(listener: () => void): () => void;
  stop(): void;
}

export function startClientScreenViewer(env: ClientScreenEnvironment, hooks: { close?: () => void } = {}): ClientScreenViewer {
  let workstation = env.readWorkstation();
  let state = createViewerState(env.randomId(), workstation);
  let role: 'starting' | 'viewer' | 'duplicate' = 'starting';
  let stopped = false;
  let watch: AbortController | null = null;
  let releaseViewerLock: (() => void) | null = null;
  const listeners = new Set<() => void>();
  const stops: Array<() => void> = [];
  const notify = () => listeners.forEach((listener) => listener());
  let channel: ReturnType<ClientScreenEnvironment['openChannel']> | null = null;

  const dispatch = (event: ViewerEvent) => {
    if (stopped || role !== 'viewer') return;
    const step = viewerReduce(state, event);
    const changed = step.state !== state;
    state = step.state;
    for (const message of step.send) channel?.post(message);
    for (const effect of step.effects) {
      if (effect.type === 'cancelWatch') {
        watch?.abort();
        watch = null;
      } else if (effect.type === 'watchOwner') {
        watch?.abort();
        const controller = new AbortController();
        watch = controller;
        const epoch = effect.epoch;
        // Queued behind the owner's lock: granted only when the owner's tab is gone or let it go.
        env.locks.request(clientScreenOwnerLock(epoch), { signal: controller.signal }, () => {
          if (!controller.signal.aborted) dispatch({ type: 'ownerLockAcquired', epoch });
        }).catch(() => undefined);
      } else if (effect.type === 'close') {
        hooks.close?.();
      }
    }
    if (changed) notify();
  };

  const onWorkstation = () => {
    const previousGen = workstation.gen;
    workstation = env.readWorkstation();
    dispatch({ type: 'workstation', workstation, previousGen });
  };

  env.locks.request(CLIENT_SCREEN_VIEWER_LOCK, { ifAvailable: true }, (lock) => {
    if (stopped) return undefined;
    if (!lock) {
      role = 'duplicate';
      notify();
      return undefined;
    }
    role = 'viewer';
    channel = env.openChannel((message) => {
      workstation = env.readWorkstation();
      dispatch({ type: 'message', message, now: env.now(), workstation });
    });
    stops.push(env.onWorkstationChange(onWorkstation));
    stops.push(env.setInterval(() => {
      // The storage event is only a hint; the record itself is re-read every second.
      const current = env.readWorkstation();
      if (current.disabled !== workstation.disabled || current.gen !== workstation.gen) onWorkstation();
      dispatch({ type: 'tick', now: env.now() });
    }, 1000));
    channel.post(clientScreenMessage('hello', { viewerId: state.viewerId }));
    notify();
    // The viewer lock is held for the life of the window.
    return new Promise<void>((resolve) => { releaseViewerLock = resolve; });
  }).catch(() => undefined);

  return {
    getState: () => state,
    getRole: () => role,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop() {
      stopped = true;
      watch?.abort();
      stops.forEach((stop) => stop());
      channel?.close();
      releaseViewerLock?.();
    },
  };
}
