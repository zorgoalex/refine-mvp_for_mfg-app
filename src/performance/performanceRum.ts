import { apiRoutes } from '../api/apiRoutes';
import { authSession } from '../api/authSession';
import { buildApiUrl } from '../api/httpClient';

export const PERFORMANCE_RUM_METRICS = [
  'primary_request_start_ms',
  'primary_data_ready_ms',
  'meaningful_ready_ms',
  'interaction_ready_ms',
  'order_show_forced_reflow_ms',
  'activity_coordinator_owner_count',
  'activity_coordinator_listener_count',
  'activity_refresh_trigger_count',
  'hidden_read_count',
  'duplicate_primary_count',
  'blocking_spinner_count',
  'heavy_dom_count',
  'lost_draft_count',
  'checkpoint_capture_failure_count',
  'unsnapshotted_surface_count',
  'operation_eviction_pin_count',
  'route_js_error_count',
  'sse_snapshot_latency_ms',
  'sse_commit_to_visible_ms',
  'sse_reconnect_count',
  'sse_fallback_duration_ms',
] as const;

export type PerformanceRumMetricName = typeof PERFORMANCE_RUM_METRICS[number];
export type PerformanceRumRoute = 'orders-list' | 'order-show' | 'order-edit';
export type OrderRealtimeMode =
  | 'frontend-off-legacy-polling'
  | 'initializing'
  | 'connected'
  | 'reconnecting'
  | 'compact-fallback'
  | 'terminal-no-transport';

export interface PerformanceRumBatch {
  schemaVersion: 1;
  sessionNonce: string;
  configVersion: string;
  buildSha: string;
  cohort: 'control' | 'treatment';
  route: PerformanceRumRoute;
  dataProfile: 'cold' | 'warm' | 'unknown';
  orderRealtimeMode: OrderRealtimeMode;
  measurements: Array<{ name: PerformanceRumMetricName; value: number }>;
}

type MetricListener = (measurement: { name: PerformanceRumMetricName; value: number }) => void;
const listeners = new Set<MetricListener>();
const STICKY_SAFETY_METRICS = new Set<PerformanceRumMetricName>([
  'operation_eviction_pin_count',
]);
const pendingSafetyMetrics = new Map<PerformanceRumMetricName, number>();

export function recordOrderLifecycleMetric(name: PerformanceRumMetricName, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 3_600_000) return;
  const recordedValue = STICKY_SAFETY_METRICS.has(name)
    ? incrementPendingSafetyMetric(name)
    : value;
  listeners.forEach((listener) => listener({ name, value: recordedValue }));
}

/**
 * Safety incidents survive workspace/auth cleanup until a successful RUM
 * submission acknowledges them. This is intentionally process-global and
 * contains no actor or entity identifiers: losing an incident is less safe
 * than conservatively carrying it into the next bounded promotion batch.
 */
export function getPendingPerformanceRumSafetyMetric(
  name: PerformanceRumMetricName,
): number {
  return pendingSafetyMetrics.get(name) ?? 0;
}

export function acknowledgePerformanceRumSafetyMetrics(
  measurements: PerformanceRumBatch['measurements'],
): void {
  for (const measurement of measurements) {
    if (!STICKY_SAFETY_METRICS.has(measurement.name) || measurement.value <= 0) continue;
    const current = pendingSafetyMetrics.get(measurement.name) ?? 0;
    const remaining = Math.max(0, current - measurement.value);
    if (remaining === 0) {
      pendingSafetyMetrics.delete(measurement.name);
    } else {
      pendingSafetyMetrics.set(measurement.name, remaining);
    }
  }
}

export function resetPerformanceRumSafetyMetricsForTests(): void {
  pendingSafetyMetrics.clear();
}

export function subscribeOrderLifecycleMetrics(listener: MetricListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function submitPerformanceRumBatch(
  batch: PerformanceRumBatch,
  options: { keepalive?: boolean; fetchImpl?: typeof fetch } = {},
): Promise<boolean> {
  const token = authSession.getAccessToken();
  if (!token) return false;
  const response = await (options.fetchImpl ?? fetch)(buildApiUrl(apiRoutes.performance.rum), {
    method: 'POST',
    credentials: 'include',
    keepalive: options.keepalive,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(batch),
  });
  return response.ok;
}

export function createRumSessionNonce(): string | null {
  return globalThis.crypto?.randomUUID?.() ?? null;
}

function incrementPendingSafetyMetric(name: PerformanceRumMetricName): number {
  const nextValue = (pendingSafetyMetrics.get(name) ?? 0) + 1;
  pendingSafetyMetrics.set(name, nextValue);
  return nextValue;
}
