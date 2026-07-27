import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BackendEnv } from '../../../config/env.validation';

@Injectable()
export class CrmSyncRuntimeConfigService {
  constructor(@Inject(ConfigService) private readonly config: ConfigService<BackendEnv, true>) {}

  getFlags() {
    return {
      enabled: this.config.get('BACKEND_ENABLE_BITRIX24_SYNC', { infer: true }) ?? false,
      relayOwner: this.config.get('BACKEND_BITRIX24_SYNC_RELAY_OWNER', { infer: true }) ?? 'none',
      dryRun: this.config.get('BACKEND_BITRIX24_SYNC_DRY_RUN', { infer: true }) ?? false,
      pollIntervalMs: this.config.get('BACKEND_BITRIX24_SYNC_POLL_INTERVAL_MS', { infer: true }),
      batchSize: this.config.get('BACKEND_BITRIX24_SYNC_BATCH_SIZE', { infer: true }),
      maxAttempts: this.config.get('BACKEND_BITRIX24_SYNC_MAX_ATTEMPTS', { infer: true }),
      workerId: this.config.get('BACKEND_BITRIX24_SYNC_WORKER_ID', { infer: true }),
      leaseMs: this.config.get('BACKEND_BITRIX24_SYNC_LEASE_MS', { infer: true }),
    };
  }

  getBitrix24() {
    const webhookUrl = this.config.get('BITRIX24_WEBHOOK_URL', { infer: true })?.trim();
    return {
      webhookUrl: webhookUrl || null,
      requestTimeoutMs: this.config.get('BITRIX24_REQUEST_TIMEOUT_MS', { infer: true }),
      maxRequestsPerSecond: this.config.get('BITRIX24_MAX_REQUESTS_PER_SECOND', { infer: true }),
      limitRetryMaxAttempts: this.config.get('BITRIX24_LIMIT_RETRY_MAX_ATTEMPTS', { infer: true }),
      queryLimitBaseDelayMs: this.config.get('BITRIX24_QUERY_LIMIT_BASE_DELAY_MS', { infer: true }),
      operationLimitFallbackDelayMs: this.config.get(
        'BITRIX24_OPERATION_LIMIT_FALLBACK_MS',
        { infer: true },
      ),
      currencyId: this.config.get('BITRIX24_CURRENCY_ID', { infer: true }),
      paySystemId: this.config.get('BITRIX24_PAY_SYSTEM_ID', { infer: true }) ?? null,
      assignedById: this.config.get('BITRIX24_ASSIGNED_BY_ID', { infer: true }) ?? null,
      erpBaseUrl: this.config.get('FRONTEND_ORIGIN', { infer: true }),
    };
  }
}
