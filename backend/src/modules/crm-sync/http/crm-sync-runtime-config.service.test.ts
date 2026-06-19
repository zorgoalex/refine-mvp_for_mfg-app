import { describe, it, expect } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { CrmSyncRuntimeConfigService } from './crm-sync-runtime-config.service';
import { envSchema } from '../../../config/env.validation';

const svc = (env: Record<string, unknown>) =>
  new CrmSyncRuntimeConfigService(new ConfigService(env) as never);

describe('CrmSyncRuntimeConfigService', () => {
  it('fail-closed by default', () => {
    const f = svc({}).getFlags();
    expect(f.enabled).toBe(false);
    expect(f.relayOwner).toBe('none');
  });

  it('reads twenty config', () => {
    expect(
      svc({ TWENTY_SYNC_BASE_URL: 'https://crm-test.mebelkz.app' }).getTwenty().baseUrl,
    ).toBe('https://crm-test.mebelkz.app');
  });

  it('reads all flags', () => {
    const f = svc({
      BACKEND_ENABLE_TWENTY_SYNC: true,
      BACKEND_TWENTY_SYNC_RELAY_OWNER: 'in_process',
      BACKEND_TWENTY_SYNC_DRY_RUN: true,
      BACKEND_TWENTY_SYNC_POLL_INTERVAL_MS: 30000,
      BACKEND_TWENTY_SYNC_BATCH_SIZE: 50,
      BACKEND_TWENTY_SYNC_MAX_ATTEMPTS: 5,
      BACKEND_TWENTY_SYNC_WORKER_ID: 'worker-1',
      BACKEND_TWENTY_SYNC_LEASE_MS: 120000,
    }).getFlags();
    expect(f.enabled).toBe(true);
    expect(f.relayOwner).toBe('in_process');
    expect(f.dryRun).toBe(true);
    expect(f.pollIntervalMs).toBe(30000);
    expect(f.batchSize).toBe(50);
    expect(f.maxAttempts).toBe(5);
    expect(f.workerId).toBe('worker-1');
    expect(f.leaseMs).toBe(120000);
  });

  it('getTwenty returns null for missing config', () => {
    const t = svc({}).getTwenty();
    expect(t.baseUrl).toBeNull();
    expect(t.apiKey).toBeNull();
  });

  it('getTwenty maps whitespace-only API key to null (fail-closed)', () => {
    const t = svc({
      TWENTY_SYNC_BASE_URL: 'https://crm-test.mebelkz.app',
      TWENTY_SYNC_API_KEY: '   ',
    }).getTwenty();
    expect(t.apiKey).toBeNull();
  });
});

describe('envSchema superRefine: BACKEND_ENABLE_TWENTY_SYNC guards', () => {
  it('throws when BACKEND_ENABLE_TWENTY_SYNC=true but URL and API key are missing', () => {
    expect(() => envSchema.parse({ BACKEND_ENABLE_TWENTY_SYNC: true })).toThrow();
  });

  it('throws when BACKEND_ENABLE_TWENTY_SYNC=true and only URL is missing', () => {
    expect(() =>
      envSchema.parse({
        BACKEND_ENABLE_TWENTY_SYNC: true,
        TWENTY_SYNC_API_KEY: 'secret-key',
      }),
    ).toThrow();
  });

  it('throws when BACKEND_ENABLE_TWENTY_SYNC=true and API key is whitespace-only (treated as absent)', () => {
    expect(() =>
      envSchema.parse({
        BACKEND_ENABLE_TWENTY_SYNC: true,
        TWENTY_SYNC_BASE_URL: 'https://crm-test.mebelkz.app',
        TWENTY_SYNC_API_KEY: '   ',
      }),
    ).toThrow();
  });

  it('throws when BACKEND_ENABLE_TWENTY_SYNC=true and only API key is missing', () => {
    expect(() =>
      envSchema.parse({
        BACKEND_ENABLE_TWENTY_SYNC: true,
        TWENTY_SYNC_BASE_URL: 'https://crm-test.mebelkz.app',
      }),
    ).toThrow();
  });

  it('does not throw when BACKEND_ENABLE_TWENTY_SYNC=false (default)', () => {
    expect(() => envSchema.parse({})).not.toThrow();
  });

  it('does not throw when BACKEND_ENABLE_TWENTY_SYNC=true and base/key/DATABASE_URL are set', () => {
    expect(() =>
      envSchema.parse({
        BACKEND_ENABLE_TWENTY_SYNC: true,
        TWENTY_SYNC_BASE_URL: 'https://crm-test.mebelkz.app',
        TWENTY_SYNC_API_KEY: 'secret-key',
        DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
      }),
    ).not.toThrow();
  });
});
