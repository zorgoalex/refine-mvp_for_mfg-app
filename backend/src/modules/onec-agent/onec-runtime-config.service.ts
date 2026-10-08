import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiError } from '../../common/errors/api-error';
import type { BackendEnv } from '../../config/env.validation';

export const ONEC_AGENT_API_PATH = 'api/integration/1c-agents/v1';

export interface OnecRuntimeConfig {
  enabled: boolean;
  agentPort: number;
  ingressSecrets: string[];
  clientCertHeader: string;
  sessionTtlMs: number;
  heartbeatIntervalMs: number;
  monitorOwner: 'none' | 'in_process';
  monitorIntervalMs: number;
  /** UTC hour of the nightly full sync; null — off. */
  nightlyFullSyncHourUtc: number | null;
  /** Stock snapshots at a date may be requested; off — the queue only finishes what was started. */
  stockSnapshots: boolean;
  etlWorkerOwner: 'none' | 'in_process';
  etlSpoolDir: string;
  etlSpoolMinFreeBytes: number;
}

const nightlyHour = (value: number | undefined): number | null =>
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 23 ? value : null;

@Injectable()
export class OnecRuntimeConfigService {
  constructor(@Inject(ConfigService) private readonly config: ConfigService<BackendEnv, true>) {}

  get(): OnecRuntimeConfig {
    const secrets = [
      this.config.get('ONEC_INGRESS_SECRET', { infer: true }),
      this.config.get('ONEC_INGRESS_SECRET_PREVIOUS', { infer: true }),
    ].filter((value): value is string => typeof value === 'string' && value.length > 0);
    return {
      enabled: this.config.get('BACKEND_ENABLE_ONEC_AGENT', { infer: true }),
      agentPort: this.config.get('ONEC_AGENT_PORT', { infer: true }),
      ingressSecrets: secrets,
      clientCertHeader: this.config.get('ONEC_CLIENT_CERT_HEADER', { infer: true }).toLowerCase(),
      sessionTtlMs: this.config.get('ONEC_AGENT_SESSION_TTL_MS', { infer: true }),
      heartbeatIntervalMs: this.config.get('ONEC_AGENT_HEARTBEAT_INTERVAL_MS', { infer: true }),
      monitorOwner: this.config.get('BACKEND_ONEC_MONITOR_OWNER', { infer: true }),
      monitorIntervalMs: this.config.get('BACKEND_ONEC_MONITOR_INTERVAL_MS', { infer: true }),
      nightlyFullSyncHourUtc: nightlyHour(this.config.get('BACKEND_ONEC_NIGHTLY_FULL_SYNC_HOUR_UTC', { infer: true })),
      stockSnapshots: this.config.get('BACKEND_ONEC_STOCK_SNAPSHOTS', { infer: true }),
      etlWorkerOwner: this.config.get('BACKEND_ONEC_ETL_WORKER_OWNER', { infer: true }),
      etlSpoolDir: this.config.get('ONEC_ETL_SPOOL_DIR', { infer: true }),
      etlSpoolMinFreeBytes: this.config.get('ONEC_ETL_SPOOL_MIN_FREE_BYTES', { infer: true }),
    };
  }

  requireEnabled(): void {
    if (!this.get().enabled) {
      throw new ApiError(503, 'ONEC_AGENT_DISABLED', 'Интеграция с 1С выключена');
    }
  }
}
