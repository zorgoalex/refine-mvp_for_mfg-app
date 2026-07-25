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
});
