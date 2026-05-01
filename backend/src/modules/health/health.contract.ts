export interface LiveHealthResponse {
  status: 'ok';
  service: string;
  timestamp: string;
  uptimeSeconds: number;
}

export interface HealthCheckStatus {
  status: 'ok' | 'degraded' | 'unavailable';
  message?: string;
}

export interface ReadyHealthResponse {
  status: 'ready' | 'not_ready';
  checks: {
    database: HealthCheckStatus;
    redis: HealthCheckStatus;
    config: HealthCheckStatus;
    integrations?: Record<string, HealthCheckStatus>;
  };
  timestamp: string;
}

export function createLiveHealthResponse(
  now: Date = new Date(),
  uptimeSeconds: number = process.uptime(),
  service = 'erp-backend',
): LiveHealthResponse {
  return {
    status: 'ok',
    service,
    timestamp: now.toISOString(),
    uptimeSeconds: Math.max(0, Math.floor(uptimeSeconds)),
  };
}

export function createReadyHealthResponse(options: {
  now?: Date;
  database: HealthCheckStatus;
  redis: HealthCheckStatus;
  config?: HealthCheckStatus;
  integrations?: Record<string, HealthCheckStatus>;
}): ReadyHealthResponse {
  const config = options.config ?? { status: 'ok' };
  const checks = {
    database: options.database,
    redis: options.redis,
    config,
    ...(options.integrations ? { integrations: options.integrations } : {}),
  };
  const status = Object.values(checks)
    .flatMap((check) =>
      check && 'status' in check ? [check] : Object.values(check as Record<string, HealthCheckStatus>),
    )
    .some((check) => check.status === 'unavailable')
    ? 'not_ready'
    : 'ready';

  return {
    status,
    checks,
    timestamp: (options.now ?? new Date()).toISOString(),
  };
}
