import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BackendEnv } from '../../../config/env.validation';

@Injectable()
export class CrmSyncRuntimeConfigService {
  constructor(@Inject(ConfigService) private readonly config: ConfigService<BackendEnv, true>) {}

  getFlags() {
    return {
      enabled: this.config.get('BACKEND_ENABLE_TWENTY_SYNC', { infer: true }) ?? false,
      relayOwner: this.config.get('BACKEND_TWENTY_SYNC_RELAY_OWNER', { infer: true }) ?? 'none',
      dryRun: this.config.get('BACKEND_TWENTY_SYNC_DRY_RUN', { infer: true }) ?? false,
      pollIntervalMs: this.config.get('BACKEND_TWENTY_SYNC_POLL_INTERVAL_MS', { infer: true }),
      batchSize: this.config.get('BACKEND_TWENTY_SYNC_BATCH_SIZE', { infer: true }),
      maxAttempts: this.config.get('BACKEND_TWENTY_SYNC_MAX_ATTEMPTS', { infer: true }),
      workerId: this.config.get('BACKEND_TWENTY_SYNC_WORKER_ID', { infer: true }),
      leaseMs: this.config.get('BACKEND_TWENTY_SYNC_LEASE_MS', { infer: true }),
    };
  }

  getTwenty() {
    return {
      baseUrl: this.config.get('TWENTY_SYNC_BASE_URL', { infer: true }) ?? null,
      apiKey: this.config.get('TWENTY_SYNC_API_KEY', { infer: true }) ?? null,
    };
  }
}
