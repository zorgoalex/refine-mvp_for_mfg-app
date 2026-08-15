import { useEffect, useSyncExternalStore } from 'react';
import { useLocation } from 'react-router-dom';
import { authSession } from '../api/authSession';
import { featureFlags } from '../config/featureFlags';
import { getLoadedRuntimeConfig } from '../config/runtimeConfig';
import { assignOrderLifecycleCohort } from './orderLifecycleRollout';
import {
  createRumSessionNonce,
  submitPerformanceRumBatch,
  subscribeOrderLifecycleMetrics,
  type OrderRealtimeMode,
  type PerformanceRumBatch,
  type PerformanceRumRoute,
} from './performanceRum';

const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;

interface ActiveRumSession {
  batch: Omit<PerformanceRumBatch, 'measurements'>;
  measurements: Map<string, PerformanceRumBatch['measurements'][number]>;
}

const ZERO_SAFETY_METRICS = [
  'hidden_read_count',
  'duplicate_primary_count',
  'blocking_spinner_count',
  'heavy_dom_count',
  'lost_draft_count',
  'checkpoint_capture_failure_count',
  'unsnapshotted_surface_count',
  'operation_eviction_pin_count',
  'route_js_error_count',
] as const;

let activeSession: ActiveRumSession | null = null;
let pendingStartGeneration = 0;

export const PerformanceRumBridge = () => {
  const location = useLocation();
  const authKey = useSyncExternalStore(
    authSession.subscribe,
    getAuthKey,
    getAuthKey,
  );

  useEffect(() => {
    const route = resolvePerformanceRumRoute(location.pathname);
    const config = getLoadedRuntimeConfig();
    const user = authSession.getUser();
    const generation = ++pendingStartGeneration;

    const startSession = async () => {
      await rotatePerformanceRumSession(route);
      if (
        generation !== pendingStartGeneration ||
        !route ||
        !authSession.getAccessToken() ||
        !user?.id ||
        config?.observability?.performanceRum !== true ||
        !config.build?.sha
      ) {
        return;
      }

      const cohort = await assignOrderLifecycleCohort(
        config.rollouts?.orderLifecycleV2,
        String(user.id),
      );
      if (generation !== pendingStartGeneration || cohort === 'disabled' || activeSession) return;
      const nonce = createRumSessionNonce();
      const rollout = config.rollouts?.orderLifecycleV2;
      if (!nonce || !rollout) return;
      const measurements: ActiveRumSession['measurements'] = new Map();
      for (const name of ZERO_SAFETY_METRICS) {
        measurements.set(name, { name, value: 0 });
      }
      activeSession = {
        batch: {
          schemaVersion: 1,
          sessionNonce: nonce,
          configVersion: rollout.configVersion,
          buildSha: config.build?.sha ?? '',
          cohort,
          route,
          dataProfile: 'unknown',
          orderRealtimeMode: initialRealtimeMode(route),
        },
        measurements,
      };
    };

    void startSession();

    return () => {
      pendingStartGeneration += 1;
    };
  }, [authKey, location.pathname]);

  useEffect(() => {
    const unsubscribeMetrics = subscribeOrderLifecycleMetrics((measurement) => {
      activeSession?.measurements.set(measurement.name, measurement);
    });
    const unsubscribeBeforeClear = authSession.subscribeBeforeClear(() => {
      void flushPerformanceRumSession(true);
    });
    const onPageHide = () => {
      void flushPerformanceRumSession(true);
    };
    let inactivityTimer = window.setTimeout(() => {
      void flushPerformanceRumSession();
    }, INACTIVITY_TIMEOUT_MS);
    const resetInactivity = () => {
      window.clearTimeout(inactivityTimer);
      inactivityTimer = window.setTimeout(() => {
        void flushPerformanceRumSession();
      }, INACTIVITY_TIMEOUT_MS);
    };

    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pointerdown', resetInactivity, { passive: true });
    window.addEventListener('keydown', resetInactivity);
    return () => {
      unsubscribeMetrics();
      unsubscribeBeforeClear();
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pointerdown', resetInactivity);
      window.removeEventListener('keydown', resetInactivity);
      window.clearTimeout(inactivityTimer);
    };
  }, []);

  return null;
};

export async function flushPerformanceRumSession(keepalive = false): Promise<boolean> {
  const session = activeSession;
  activeSession = null;
  if (!session || session.measurements.size === 0) return false;
  return submitPerformanceRumBatch(
    { ...session.batch, measurements: [...session.measurements.values()] },
    { keepalive },
  ).catch(() => false);
}

export function setPerformanceRumRealtimeMode(mode: OrderRealtimeMode): void {
  if (activeSession) activeSession.batch.orderRealtimeMode = mode;
}

export function rotatePerformanceRumSession(
  nextRoute: PerformanceRumRoute | null,
): Promise<boolean> {
  if (!activeSession || activeSession.batch.route === nextRoute) return Promise.resolve(false);
  return flushPerformanceRumSession();
}

export function setActivePerformanceRumSessionForTests(batch: PerformanceRumBatch): void {
  activeSession = {
    batch: {
      schemaVersion: batch.schemaVersion,
      sessionNonce: batch.sessionNonce,
      configVersion: batch.configVersion,
      buildSha: batch.buildSha,
      cohort: batch.cohort,
      route: batch.route,
      dataProfile: batch.dataProfile,
      orderRealtimeMode: batch.orderRealtimeMode,
    },
    measurements: new Map(batch.measurements.map((measurement) => [measurement.name, measurement])),
  };
}

export function resolvePerformanceRumRoute(pathname: string): PerformanceRumRoute | null {
  if (pathname === '/orders' || pathname === '/orders/') return 'orders-list';
  if (/^\/orders\/show\/[^/]+\/?$/.test(pathname)) return 'order-show';
  if (/^\/orders\/edit\/[^/]+\/?$/.test(pathname)) return 'order-edit';
  return null;
}

function getAuthKey(): string {
  return `${authSession.getAccessTokenVersion()}:${authSession.getUser()?.id ?? ''}`;
}

function initialRealtimeMode(route: PerformanceRumRoute): OrderRealtimeMode {
  if (route !== 'order-show') return 'terminal-no-transport';
  return featureFlags.orderRealtime ? 'initializing' : 'frontend-off-legacy-polling';
}
