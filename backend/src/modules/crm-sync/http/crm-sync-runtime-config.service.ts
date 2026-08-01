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

  getReverseSync() {
    const publicBaseUrl = this.config
      .get('BITRIX24_APP_PUBLIC_BASE_URL', { infer: true })
      ?.replace(/\/+$/, '');
    return {
      enabled:
        this.config.get('BACKEND_ENABLE_BITRIX24_REVERSE_SYNC', { infer: true }) ?? false,
      relayOwner:
        this.config.get('BACKEND_BITRIX24_REVERSE_SYNC_RELAY_OWNER', { infer: true }) ?? 'none',
      dryRun:
        this.config.get('BACKEND_BITRIX24_REVERSE_SYNC_DRY_RUN', { infer: true }) ?? false,
      pollIntervalMs: this.config.get(
        'BACKEND_BITRIX24_REVERSE_SYNC_POLL_INTERVAL_MS',
        { infer: true },
      ),
      batchSize: this.config.get('BACKEND_BITRIX24_REVERSE_SYNC_BATCH_SIZE', { infer: true }),
      maxAttempts: this.config.get(
        'BACKEND_BITRIX24_REVERSE_SYNC_MAX_ATTEMPTS',
        { infer: true },
      ),
      workerId: this.config.get(
        'BACKEND_BITRIX24_REVERSE_SYNC_WORKER_ID',
        { infer: true },
      ),
      leaseMs: this.config.get('BACKEND_BITRIX24_REVERSE_SYNC_LEASE_MS', { infer: true }),
      actorUserId:
        this.config.get('BACKEND_BITRIX24_REVERSE_SYNC_ACTOR_USER_ID', { infer: true }) ?? null,
      initialOrderStatusCode:
        this.config.get('BACKEND_ORDER_INITIAL_STATUS_CODE', { infer: true }) ?? null,
      initialProductionStatusCode:
        this.config.get('BACKEND_ORDER_INITIAL_PRODUCTION_STATUS_CODE', { infer: true }) ?? null,
      reconcileIntervalMs: this.config.get(
        'BACKEND_BITRIX24_RECONCILE_INTERVAL_MS',
        { infer: true },
      ),
      appClientId: this.config.get('BITRIX24_APP_CLIENT_ID', { infer: true }) ?? null,
      appClientSecret: this.config.get('BITRIX24_APP_CLIENT_SECRET', { infer: true }) ?? null,
      tokenEncryptionKey:
        this.config.get('BITRIX24_APP_TOKEN_ENCRYPTION_KEY', { infer: true }) ?? null,
      publicBaseUrl: publicBaseUrl || null,
      portalDomain: this.config.get('BITRIX24_APP_PORTAL_DOMAIN', { infer: true }),
      portalTimezone: this.config.get('BITRIX24_PORTAL_TIMEZONE', { infer: true }),
      apiPrefix: this.config.get('API_PREFIX', { infer: true }),
    };
  }

  isProductionInitializationReady(): boolean {
    return Boolean(
      this.config.get('BACKEND_ENABLE_DEADLINES', { infer: true }) &&
      !this.config.get('BACKEND_DEADLINES_READ_ONLY', { infer: true }) &&
      this.config.get('BACKEND_ENABLE_DEADLINE_ORDER_SYNC', { infer: true }),
    );
  }
}
