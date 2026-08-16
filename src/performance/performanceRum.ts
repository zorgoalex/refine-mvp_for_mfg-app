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

export function recordOrderLifecycleMetric(name: PerformanceRumMetricName, value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 3_600_000) return;
  listeners.forEach((listener) => listener({ name, value }));
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
