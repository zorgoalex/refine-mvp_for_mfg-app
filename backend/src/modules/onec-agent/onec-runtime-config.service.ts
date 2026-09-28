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
  etlWorkerOwner: 'none' | 'in_process';
  etlSpoolDir: string;
  etlSpoolMinFreeBytes: number;
}

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
