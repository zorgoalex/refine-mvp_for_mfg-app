import { z } from 'zod';

export const RUM_METRIC_NAMES = [
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

export const ORDER_REALTIME_MODES = [
  'frontend-off-legacy-polling',
  'initializing',
  'connected',
  'reconnecting',
  'compact-fallback',
  'terminal-no-transport',
] as const;

const measurementSchema = z.object({
  name: z.enum(RUM_METRIC_NAMES),
  value: z.number().finite().min(0).max(3_600_000),
}).strict();

export const performanceRumBatchSchema = z.object({
  schemaVersion: z.literal(1),
  sessionNonce: z.string().uuid(),
  configVersion: z.string().trim().min(1).max(64).regex(/^[a-zA-Z0-9._-]+$/),
  buildSha: z.string().trim().min(7).max(64).regex(/^[a-zA-Z0-9._-]+$/),
  cohort: z.enum(['control', 'treatment']),
  route: z.enum(['orders-list', 'order-show', 'order-edit']),
  dataProfile: z.enum(['cold', 'warm', 'unknown']),
  orderRealtimeMode: z.enum(ORDER_REALTIME_MODES),
  measurements: z.array(measurementSchema).min(1).max(32),
}).strict();

export type PerformanceRumBatch = z.infer<typeof performanceRumBatchSchema>;

export function parsePerformanceRumBatch(value: unknown): PerformanceRumBatch {
  const parsed = performanceRumBatchSchema.safeParse(value);
  if (!parsed.success) {
    throw parsed.error;
  }
  return parsed.data;
}
