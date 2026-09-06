import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { envSchema } from '../../../config/env.validation';
import { CrmSyncRuntimeConfigService } from './crm-sync-runtime-config.service';

const svc = (env: Record<string, unknown>) =>
  new CrmSyncRuntimeConfigService(new ConfigService(env) as never);

describe('CrmSyncRuntimeConfigService', () => {
  it('is fail-closed by default', () => {
    const flags = svc({}).getFlags();
    expect(flags.enabled).toBe(false);
    expect(flags.relayOwner).toBe('none');
  });

  it('reads all Bitrix24 sync flags', () => {
    expect(
      svc({
        BACKEND_ENABLE_BITRIX24_SYNC: true,
        BACKEND_BITRIX24_SYNC_RELAY_OWNER: 'in_process',
        BACKEND_BITRIX24_SYNC_DRY_RUN: true,
        BACKEND_BITRIX24_SYNC_POLL_INTERVAL_MS: 30000,
        BACKEND_BITRIX24_SYNC_BATCH_SIZE: 50,
        BACKEND_BITRIX24_SYNC_MAX_ATTEMPTS: 5,
        BACKEND_BITRIX24_SYNC_WORKER_ID: 'worker-1',
        BACKEND_BITRIX24_SYNC_LEASE_MS: 120000,
      }).getFlags(),
    ).toEqual({
      enabled: true,
      relayOwner: 'in_process',
      dryRun: true,
      pollIntervalMs: 30000,
      batchSize: 50,
      maxAttempts: 5,
      workerId: 'worker-1',
      leaseMs: 120000,
    });
  });

  it('returns normalized Bitrix24 settings', () => {
    expect(
      svc({
        BITRIX24_WEBHOOK_URL: ' https://mebelkz.bitrix24.kz/rest/1/secret/ ',
        BITRIX24_REQUEST_TIMEOUT_MS: 25000,
        BITRIX24_MAX_REQUESTS_PER_SECOND: 2,
        BITRIX24_LIMIT_RETRY_MAX_ATTEMPTS: 11,
        BITRIX24_QUERY_LIMIT_BASE_DELAY_MS: 1000,
        BITRIX24_OPERATION_LIMIT_FALLBACK_MS: 60000,
        BITRIX24_CURRENCY_ID: 'KZT',
        BITRIX24_PAY_SYSTEM_ID: 7,
        BITRIX24_ASSIGNED_BY_ID: 9,
        FRONTEND_ORIGIN: 'https://erp.example.com',
      }).getBitrix24(),
    ).toEqual({
        webhookUrl: 'https://mebelkz.bitrix24.kz/rest/1/secret/',
        requestTimeoutMs: 25000,
      maxRequestsPerSecond: 2,
      limitRetryMaxAttempts: 11,
      queryLimitBaseDelayMs: 1000,
      operationLimitFallbackDelayMs: 60000,
      currencyId: 'KZT',
      paySystemId: 7,
      assignedById: 9,
      erpBaseUrl: 'https://erp.example.com',
    });
  });

  it('returns null for an absent webhook and optional IDs', () => {
    expect(svc({}).getBitrix24()).toMatchObject({
      webhookUrl: null,
      requestTimeoutMs: undefined,
      maxRequestsPerSecond: undefined,
      limitRetryMaxAttempts: undefined,
      paySystemId: null,
      assignedById: null,
    });
  });

  it('reads fail-closed Bitrix24 payment widget settings', () => {
    expect(svc({}).getPaymentWidget()).toMatchObject({ enabled: false });
    expect(svc({
      BACKEND_ENABLE_BITRIX24_PAYMENT_WIDGET: true,
      BITRIX24_WIDGET_SESSION_ENCRYPTION_KEY: 'session-key',
      BITRIX24_WIDGET_COMMAND_TOKEN_ENCRYPTION_KEY: 'command-key',
      BITRIX24_WIDGET_SESSION_TTL_SECONDS: 600,
      BITRIX24_WIDGET_COMMAND_TOKEN_RETENTION_DAYS: 30,
      BITRIX24_WIDGET_PAY_SYSTEM_CACHE_TTL_SECONDS: 900,
      BITRIX24_WIDGET_COMMAND_LEASE_MS: 180000,
    }).getPaymentWidget()).toEqual({
      enabled: true,
      sessionEncryptionKey: 'session-key',
      commandTokenEncryptionKey: 'command-key',
      sessionTtlSeconds: 600,
      commandTokenRetentionDays: 30,
      paySystemCacheTtlSeconds: 900,
      commandLeaseMs: 180000,
    });
  });
});

describe('envSchema Bitrix24 sync guards', () => {
  const valid = {
    BACKEND_ENABLE_BITRIX24_SYNC: true,
    BITRIX24_WEBHOOK_URL: 'https://mebelkz.bitrix24.kz/rest/1/secret/',
    BITRIX24_PAY_SYSTEM_ID: 7,
    DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
  };

  it('allows disabled sync without credentials', () => {
    expect(() => envSchema.parse({})).not.toThrow();
  });

  it('requires database, HTTPS webhook and payment system when enabled', () => {
    expect(() => envSchema.parse({ ...valid, DATABASE_URL: undefined })).toThrow(/DATABASE_URL/);
    expect(() => envSchema.parse({ ...valid, BITRIX24_WEBHOOK_URL: undefined })).toThrow(
      /BITRIX24_WEBHOOK_URL/,
    );
    expect(() =>
      envSchema.parse({
        ...valid,
        BITRIX24_WEBHOOK_URL: 'http://mebelkz.bitrix24.kz/rest/1/secret/',
      }),
    ).toThrow(/HTTPS incoming webhook/);
    expect(() => envSchema.parse({ ...valid, BITRIX24_PAY_SYSTEM_ID: undefined })).toThrow(
      /BITRIX24_PAY_SYSTEM_ID/,
    );
  });

  it('accepts complete enabled configuration', () => {
    expect(envSchema.parse(valid)).toMatchObject({
      ...valid,
      BITRIX24_MAX_REQUESTS_PER_SECOND: 2,
      BITRIX24_LIMIT_RETRY_MAX_ATTEMPTS: 11,
      BITRIX24_QUERY_LIMIT_BASE_DELAY_MS: 1000,
      BITRIX24_OPERATION_LIMIT_FALLBACK_MS: 60000,
    });
  });

  it('bounds Bitrix24 rate and retry settings', () => {
    expect(() => envSchema.parse({
      ...valid,
      BITRIX24_MAX_REQUESTS_PER_SECOND: 6,
    })).toThrow(/BITRIX24_MAX_REQUESTS_PER_SECOND/);
    expect(() => envSchema.parse({
      ...valid,
      BITRIX24_LIMIT_RETRY_MAX_ATTEMPTS: 0,
    })).toThrow(/BITRIX24_LIMIT_RETRY_MAX_ATTEMPTS/);
  });

  it('requires three distinct 32-byte encryption keys for the payment widget', () => {
    const key = Buffer.alloc(32, 1).toString('base64');
    const sessionKey = Buffer.alloc(32, 2).toString('base64');
    const commandKey = Buffer.alloc(32, 3).toString('base64');
    const widget = {
      BACKEND_ENABLE_BITRIX24_REVERSE_SYNC: true,
      BACKEND_ENABLE_BITRIX24_PAYMENT_WIDGET: true,
      BACKEND_ENABLE_ORDERS: true,
      BACKEND_ORDERS_READ_ONLY: false,
      BACKEND_ENABLE_PAYMENTS: true,
      BACKEND_BITRIX24_REVERSE_SYNC_ACTOR_USER_ID: 86,
      BACKEND_ORDER_INITIAL_STATUS_CODE: 'new',
      BACKEND_ORDER_INITIAL_PRODUCTION_STATUS_CODE: 'new',
      DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
      BITRIX24_APP_CLIENT_ID: 'local.erp',
      BITRIX24_APP_CLIENT_SECRET: 'secret',
      BITRIX24_APP_TOKEN_ENCRYPTION_KEY: key,
      BITRIX24_APP_PUBLIC_BASE_URL: 'https://backend.example.test',
      BITRIX24_WIDGET_SESSION_ENCRYPTION_KEY: sessionKey,
      BITRIX24_WIDGET_COMMAND_TOKEN_ENCRYPTION_KEY: commandKey,
    };
    expect(() => envSchema.parse(widget)).not.toThrow();
    expect(() => envSchema.parse({
      ...widget,
      BITRIX24_WIDGET_COMMAND_TOKEN_ENCRYPTION_KEY: sessionKey,
    })).toThrow(/must be distinct/);
  });
});
