import { describe, expect, it } from 'vitest';
import { validateEnv } from './env.validation';

describe('backend env validation', () => {
  it('uses safe local defaults without DB settings', () => {
    expect(validateEnv({})).toMatchObject({
      NODE_ENV: 'development',
      API_PREFIX: '/api/v1',
      PORT: 3000,
      FRONTEND_ORIGIN: 'http://localhost:5173',
      LOG_LEVEL: 'info',
      TRUST_PROXY: false,
      REQUEST_ID_HEADER: 'x-request-id',
      DATABASE_SSL: false,
      DATABASE_POOL_MIN: 1,
      DATABASE_POOL_MAX: 10,
      DATABASE_QUERY_TIMEOUT_MS: 10000,
      BACKEND_RATE_LIMIT_STORE: 'memory',
      ACCESS_TOKEN_TTL_SECONDS: 900,
      REFRESH_TOKEN_TTL_DAYS: 7,
      REFRESH_COOKIE_SAME_SITE: 'lax',
      BACKEND_ENABLE_DEADLINES: false,
      BACKEND_ENABLE_GROUPS: false,
      BACKEND_ENABLE_GROUPS_BATCH_LINK_WRITE: false,
      BACKEND_ENABLE_PAYMENTS: false,
      BACKEND_ENABLE_PRODUCTION_ACTIONS: false,
      BACKEND_ENABLE_LABELS: false,
      BACKEND_DEADLINES_READ_ONLY: true,
      BACKEND_GROUPS_READ_ONLY: true,
      BACKEND_ENABLE_DEADLINE_WORKER: false,
      BACKEND_DEADLINE_WORKER_SCHEDULER_OWNER: 'none',
      BACKEND_ENABLE_DEADLINE_ORDER_SYNC: false,
      BACKEND_DEADLINE_WORKER_POLL_INTERVAL_MS: 60000,
      BACKEND_DEADLINE_WORKER_BATCH_SIZE: 100,
      BACKEND_DEADLINE_WORKER_ID: 'backend-local',
      BACKEND_DEADLINE_ACTIONS_ENABLED: false,
      BACKEND_DEADLINE_NOTIFICATIONS_ENABLED: false,
      GAS_EXPORT_TIMEOUT_MS: 55000,
      VLM_HEALTH_TIMEOUT_MS: 10000,
      VLM_UPLOAD_TIMEOUT_MS: 30000,
      VLM_ANALYZE_TIMEOUT_MS: 90000,
      VLM_ANALYZE_DAILY_LIMIT: 100,
    });
  });

  it('parses numeric and boolean env values', () => {
    expect(
      validateEnv({
        NODE_ENV: 'test',
        PORT: '3100',
        FRONTEND_ORIGIN: 'http://localhost:5173',
        API_PREFIX: 'api/v2',
        DATABASE_URL: 'postgres://erp_user:erp_password@localhost:5432/erp',
        DATABASE_SSL: 'true',
        DATABASE_POOL_MIN: '2',
        DATABASE_POOL_MAX: '20',
        DATABASE_QUERY_TIMEOUT_MS: '15000',
        JWT_ACCESS_SECRET: 'x'.repeat(32),
        REFRESH_TOKEN_PEPPER: 'y'.repeat(32),
        ACCESS_TOKEN_TTL_SECONDS: '1200',
        REFRESH_TOKEN_TTL_DAYS: '14',
        REFRESH_COOKIE_SECURE: 'true',
        REFRESH_COOKIE_SAME_SITE: 'None',
        TRUST_PROXY: 'true',
        BACKEND_RATE_LIMIT_STORE: 'redis',
        RATE_LIMIT_REDIS_URL: 'redis://localhost:6379',
        BACKEND_ENABLE_PAYMENTS: 'true',
        BACKEND_ENABLE_PRODUCTION_ACTIONS: 'true',
        BACKEND_ENABLE_DEADLINES: 'true',
        BACKEND_ENABLE_GROUPS: 'true',
        BACKEND_ENABLE_GROUPS_BATCH_LINK_WRITE: 'true',
        BACKEND_GROUPS_READ_ONLY: 'false',
        BACKEND_DEADLINES_READ_ONLY: 'false',
        BACKEND_ENABLE_DEADLINE_WORKER: 'true',
        BACKEND_ENABLE_DEADLINE_ORDER_SYNC: 'true',
        BACKEND_DEADLINE_WORKER_POLL_INTERVAL_MS: '15000',
        BACKEND_DEADLINE_WORKER_BATCH_SIZE: '25',
        BACKEND_DEADLINE_WORKER_ID: 'worker-a',
        BACKEND_DEADLINE_ACTIONS_ENABLED: 'true',
        BACKEND_DEADLINE_NOTIFICATIONS_ENABLED: 'true',
        GAS_WEBAPP_URL: 'https://script.google.com/macros/s/test/exec',
        GAS_API_KEY: 'gas-key',
        GAS_EXPORT_TIMEOUT_MS: '30000',
        VLM_API_URL: 'https://vlm.example.test',
        VLM_HEALTH_TIMEOUT_MS: '5000',
        VLM_UPLOAD_TIMEOUT_MS: '15000',
        VLM_ANALYZE_TIMEOUT_MS: '45000',
        VLM_ANALYZE_DAILY_LIMIT: '25',
        AUTH0_M2M_DOMAIN: 'auth.example.test',
        AUTH0_M2M_CLIENT_ID: 'client-id',
        AUTH0_M2M_CLIENT_SECRET: 'client-secret',
        AUTH0_M2M_AUDIENCE: 'https://vlm.example.test',
        VLM_MAX_UPLOAD_MB: '25',
        VLM_ALLOWED_MIME_TYPES: 'image/png,image/jpeg',
      }),
    ).toMatchObject({
      NODE_ENV: 'test',
      API_PREFIX: '/api/v2',
      PORT: 3100,
      DATABASE_SSL: true,
      DATABASE_POOL_MIN: 2,
      DATABASE_POOL_MAX: 20,
      DATABASE_QUERY_TIMEOUT_MS: 15000,
      ACCESS_TOKEN_TTL_SECONDS: 1200,
      REFRESH_TOKEN_TTL_DAYS: 14,
      REFRESH_COOKIE_SECURE: true,
      REFRESH_COOKIE_SAME_SITE: 'none',
      TRUST_PROXY: true,
      BACKEND_RATE_LIMIT_STORE: 'redis',
      RATE_LIMIT_REDIS_URL: 'redis://localhost:6379',
      BACKEND_ENABLE_PAYMENTS: true,
      BACKEND_ENABLE_PRODUCTION_ACTIONS: true,
      BACKEND_ENABLE_DEADLINES: true,
      BACKEND_ENABLE_GROUPS: true,
      BACKEND_ENABLE_GROUPS_BATCH_LINK_WRITE: true,
      BACKEND_GROUPS_READ_ONLY: false,
      BACKEND_DEADLINES_READ_ONLY: false,
      BACKEND_ENABLE_DEADLINE_WORKER: true,
      BACKEND_ENABLE_DEADLINE_ORDER_SYNC: true,
      BACKEND_DEADLINE_WORKER_POLL_INTERVAL_MS: 15000,
      BACKEND_DEADLINE_WORKER_BATCH_SIZE: 25,
      BACKEND_DEADLINE_WORKER_ID: 'worker-a',
      BACKEND_DEADLINE_ACTIONS_ENABLED: true,
      BACKEND_DEADLINE_NOTIFICATIONS_ENABLED: true,
      GAS_WEBAPP_URL: 'https://script.google.com/macros/s/test/exec',
      GAS_API_KEY: 'gas-key',
      GAS_EXPORT_TIMEOUT_MS: 30000,
      VLM_API_URL: 'https://vlm.example.test',
      VLM_HEALTH_TIMEOUT_MS: 5000,
      VLM_UPLOAD_TIMEOUT_MS: 15000,
      VLM_ANALYZE_TIMEOUT_MS: 45000,
      VLM_ANALYZE_DAILY_LIMIT: 25,
      AUTH0_M2M_DOMAIN: 'auth.example.test',
      AUTH0_M2M_CLIENT_ID: 'client-id',
      AUTH0_M2M_CLIENT_SECRET: 'client-secret',
      AUTH0_M2M_AUDIENCE: 'https://vlm.example.test',
      VLM_MAX_UPLOAD_MB: 25,
      VLM_ALLOWED_MIME_TYPES: 'image/png,image/jpeg',
    });
  });

  it('requires explicit frontend origin in production', () => {
    expect(() => validateEnv({ NODE_ENV: 'production' })).toThrow(
      /FRONTEND_ORIGIN is required in production/,
    );
  });

  it('rejects invalid port and origin values', () => {
    expect(() =>
      validateEnv({
        PORT: '70000',
        FRONTEND_ORIGIN: 'not-a-url',
      }),
    ).toThrow(/Invalid backend environment/);
  });

  it('validates database runtime settings when provided or required', () => {
    expect(() =>
      validateEnv({
        DATABASE_URL: 'http://localhost:5432/erp',
      }),
    ).toThrow(/DATABASE_URL/);

    expect(() =>
      validateEnv({
        READINESS_REQUIRE_DATABASE: 'true',
      }),
    ).toThrow(/DATABASE_URL is required/);

    expect(() =>
      validateEnv({
        DATABASE_POOL_MIN: '5',
        DATABASE_POOL_MAX: '3',
      }),
    ).toThrow(/DATABASE_POOL_MIN/);

    expect(() =>
      validateEnv({
        DATABASE_QUERY_TIMEOUT_MS: '0',
      }),
    ).toThrow(/DATABASE_QUERY_TIMEOUT_MS/);
  });

  it('requires DB and auth secrets when backend auth is enabled', () => {
    expect(() =>
      validateEnv({
        BACKEND_ENABLE_AUTH: 'true',
      }),
    ).toThrow(/DATABASE_URL.*JWT_ACCESS_SECRET.*REFRESH_TOKEN_PEPPER/);

    expect(
      validateEnv({
        BACKEND_ENABLE_AUTH: 'true',
        DATABASE_URL: 'postgres://erp_user:erp_password@localhost:5432/erp',
        JWT_ACCESS_SECRET: 'x'.repeat(32),
        REFRESH_TOKEN_PEPPER: 'y'.repeat(32),
      }),
    ).toMatchObject({
      BACKEND_ENABLE_AUTH: true,
      JWT_ACCESS_SECRET: 'x'.repeat(32),
      REFRESH_TOKEN_PEPPER: 'y'.repeat(32),
      });
  });

  it('validates Redis-backed rate limit runtime settings', () => {
    expect(() =>
      validateEnv({
        BACKEND_RATE_LIMIT_STORE: 'redis',
      }),
    ).toThrow(/REDIS_URL or RATE_LIMIT_REDIS_URL/);

    expect(() =>
      validateEnv({
        READINESS_REQUIRE_REDIS: 'true',
      }),
    ).toThrow(/REDIS_URL or RATE_LIMIT_REDIS_URL/);

    expect(() =>
      validateEnv({
        READINESS_REQUIRE_REDIS: 'true',
        RATE_LIMIT_REDIS_URL: 'redis://localhost:6379',
      }),
    ).toThrow(/BACKEND_RATE_LIMIT_STORE=redis/);

    expect(() =>
      validateEnv({
        NODE_ENV: 'staging',
        FRONTEND_ORIGIN: 'https://stage.example.test',
      }),
    ).toThrow(/BACKEND_RATE_LIMIT_STORE=redis/);

    expect(
      validateEnv({
        NODE_ENV: 'staging',
        FRONTEND_ORIGIN: 'https://stage.example.test',
        BACKEND_RATE_LIMIT_STORE: 'redis',
        RATE_LIMIT_REDIS_URL: 'redis://localhost:6379',
      }),
    ).toMatchObject({
      BACKEND_RATE_LIMIT_STORE: 'redis',
      RATE_LIMIT_REDIS_URL: 'redis://localhost:6379',
    });
  });

  it('requires secure refresh cookies for SameSite=None auth canaries', () => {
    expect(() =>
      validateEnv({
        BACKEND_ENABLE_AUTH: 'true',
        DATABASE_URL: 'postgres://erp_user:erp_password@localhost:5432/erp',
        JWT_ACCESS_SECRET: 'x'.repeat(32),
        REFRESH_TOKEN_PEPPER: 'y'.repeat(32),
        REFRESH_COOKIE_SAME_SITE: 'none',
      }),
    ).toThrow(/REFRESH_COOKIE_SECURE=true/);

    expect(
      validateEnv({
        NODE_ENV: 'staging',
        BACKEND_ENABLE_AUTH: 'true',
        DATABASE_URL: 'postgres://erp_user:erp_password@localhost:5432/erp',
        JWT_ACCESS_SECRET: 'x'.repeat(32),
        REFRESH_TOKEN_PEPPER: 'y'.repeat(32),
        REFRESH_COOKIE_SAME_SITE: 'none',
        REFRESH_COOKIE_SECURE: 'true',
        BACKEND_RATE_LIMIT_STORE: 'redis',
        RATE_LIMIT_REDIS_URL: 'redis://localhost:6379',
      }),
    ).toMatchObject({
      REFRESH_COOKIE_SAME_SITE: 'none',
      REFRESH_COOKIE_SECURE: true,
    });
  });

  it('requires DB and GAS settings when order export is enabled for writes', () => {
    expect(() =>
      validateEnv({
        BACKEND_ENABLE_ORDER_EXPORT: 'true',
        BACKEND_EXPORT_DISABLED: 'false',
      }),
    ).toThrow(/DATABASE_URL.*GAS_WEBAPP_URL.*GAS_API_KEY/);

    expect(
      validateEnv({
        BACKEND_ENABLE_ORDER_EXPORT: 'true',
        BACKEND_EXPORT_DISABLED: 'false',
        DATABASE_URL: 'postgres://erp_user:erp_password@localhost:5432/erp',
        GAS_WEBAPP_URL: 'https://script.google.com/macros/s/test/exec',
        GAS_API_KEY: 'gas-key',
      }),
    ).toMatchObject({
      BACKEND_ENABLE_ORDER_EXPORT: true,
      BACKEND_EXPORT_DISABLED: false,
      GAS_WEBAPP_URL: 'https://script.google.com/macros/s/test/exec',
      GAS_API_KEY: 'gas-key',
    });
  });

  it('requires DB when backend payments are enabled', () => {
    expect(() =>
      validateEnv({
        BACKEND_ENABLE_PAYMENTS: 'true',
      }),
    ).toThrow(/DATABASE_URL is required when BACKEND_ENABLE_PAYMENTS is true/);

    expect(
      validateEnv({
        BACKEND_ENABLE_PAYMENTS: 'true',
        DATABASE_URL: 'postgres://erp_user:erp_password@localhost:5432/erp',
      }),
    ).toMatchObject({
      BACKEND_ENABLE_PAYMENTS: true,
    });
  });

  it('requires DB when backend client phones are enabled', () => {
    expect(() =>
      validateEnv({
        BACKEND_ENABLE_CLIENT_PHONES: 'true',
        BACKEND_ENABLE_PRODUCTION_ACTIONS: 'true',
      }),
    ).toThrow(/DATABASE_URL is required when BACKEND_ENABLE_CLIENT_PHONES is true/);

    expect(() =>
      validateEnv({
        BACKEND_ENABLE_CLIENT_PHONES: 'true',
        DATABASE_URL: 'postgres://erp_user:erp_password@localhost:5432/erp',
      }),
    ).toThrow(/BACKEND_ENABLE_PRODUCTION_ACTIONS=true is required/);

    expect(
      validateEnv({
        BACKEND_ENABLE_CLIENT_PHONES: 'true',
        BACKEND_ENABLE_PRODUCTION_ACTIONS: 'true',
        DATABASE_URL: 'postgres://erp_user:erp_password@localhost:5432/erp',
      }),
    ).toMatchObject({
      BACKEND_ENABLE_CLIENT_PHONES: true,
      BACKEND_ENABLE_PRODUCTION_ACTIONS: true,
    });
  });

  it('requires DB when backend production actions are enabled', () => {
    expect(() =>
      validateEnv({
        BACKEND_ENABLE_PRODUCTION_ACTIONS: 'true',
      }),
    ).toThrow(/DATABASE_URL is required when BACKEND_ENABLE_PRODUCTION_ACTIONS is true/);

    expect(
      validateEnv({
        BACKEND_ENABLE_PRODUCTION_ACTIONS: 'true',
        DATABASE_URL: 'postgres://erp_user:erp_password@localhost:5432/erp',
      }),
    ).toMatchObject({
      BACKEND_ENABLE_PRODUCTION_ACTIONS: true,
    });
  });

  it('treats empty optional integration env values as unset when integrations are disabled', () => {
    expect(
      validateEnv({
        BACKEND_ENABLE_ORDER_EXPORT: 'true',
        BACKEND_EXPORT_DISABLED: 'true',
        GAS_WEBAPP_URL: '',
        GAS_API_KEY: '',
        BACKEND_ENABLE_VLM: 'true',
        BACKEND_VLM_DISABLED: 'true',
        VLM_API_URL: '',
        AUTH0_M2M_DOMAIN: '',
        AUTH0_M2M_CLIENT_ID: '',
        AUTH0_M2M_CLIENT_SECRET: '',
        AUTH0_M2M_AUDIENCE: '',
      }),
    ).toMatchObject({
      BACKEND_ENABLE_ORDER_EXPORT: true,
      BACKEND_EXPORT_DISABLED: true,
      GAS_WEBAPP_URL: undefined,
      GAS_API_KEY: undefined,
      BACKEND_ENABLE_VLM: true,
      BACKEND_VLM_DISABLED: true,
      VLM_API_URL: undefined,
      AUTH0_M2M_DOMAIN: undefined,
      AUTH0_M2M_CLIENT_ID: undefined,
      AUTH0_M2M_CLIENT_SECRET: undefined,
      AUTH0_M2M_AUDIENCE: undefined,
    });
  });

  it('requires a versioned API prefix', () => {
    expect(() =>
      validateEnv({
        API_PREFIX: '/api',
      }),
    ).toThrow(/API_PREFIX/);
  });

  it('rejects invalid VLM upload limits', () => {
    expect(() =>
      validateEnv({
        VLM_MAX_UPLOAD_MB: '0',
      }),
    ).toThrow(/VLM_MAX_UPLOAD_MB/);
    expect(() =>
      validateEnv({
        VLM_ALLOWED_MIME_TYPES: '',
      }),
    ).toThrow(/VLM_ALLOWED_MIME_TYPES/);
  });

  it('requires DB, VLM API, and Auth0 M2M settings when VLM actions are enabled', () => {
    expect(() =>
      validateEnv({
        BACKEND_ENABLE_VLM: 'true',
        BACKEND_VLM_DISABLED: 'false',
      }),
    ).toThrow(/DATABASE_URL.*VLM_API_URL.*AUTH0_M2M_DOMAIN.*AUTH0_M2M_CLIENT_ID.*AUTH0_M2M_CLIENT_SECRET.*AUTH0_M2M_AUDIENCE/);

    expect(
      validateEnv({
        BACKEND_ENABLE_VLM: 'true',
        BACKEND_VLM_DISABLED: 'false',
        DATABASE_URL: 'postgres://erp_user:erp_password@localhost:5432/erp',
        VLM_API_URL: 'https://vlm.example.test',
        AUTH0_M2M_DOMAIN: 'auth.example.test',
        AUTH0_M2M_CLIENT_ID: 'client-id',
        AUTH0_M2M_CLIENT_SECRET: 'client-secret',
        AUTH0_M2M_AUDIENCE: 'https://vlm.example.test',
      }),
    ).toMatchObject({
      BACKEND_ENABLE_VLM: true,
      BACKEND_VLM_DISABLED: false,
      VLM_API_URL: 'https://vlm.example.test',
    });
  });

  it('rejects invalid deadline worker settings', () => {
    expect(() =>
      validateEnv({
        BACKEND_DEADLINE_WORKER_POLL_INTERVAL_MS: '0',
      }),
    ).toThrow(/BACKEND_DEADLINE_WORKER_POLL_INTERVAL_MS/);
    expect(() =>
      validateEnv({
        BACKEND_DEADLINE_WORKER_BATCH_SIZE: '0',
      }),
    ).toThrow(/BACKEND_DEADLINE_WORKER_BATCH_SIZE/);
    expect(() =>
      validateEnv({
        BACKEND_DEADLINE_WORKER_ID: '',
      }),
    ).toThrow(/BACKEND_DEADLINE_WORKER_ID/);
  });

  it('keeps deadline scheduler owner disabled by default and separate from manual worker gate', () => {
    const env = validateEnv({});

    expect(env.BACKEND_ENABLE_DEADLINE_WORKER).toBe(false);
    expect(env.BACKEND_DEADLINE_WORKER_SCHEDULER_OWNER).toBe('none');
    expect(env.BACKEND_DEADLINE_WORKER_POLL_INTERVAL_MS).toBe(60000);
    expect(env.BACKEND_DEADLINE_WORKER_BATCH_SIZE).toBe(100);
    expect(env.BACKEND_DEADLINE_WORKER_ID).toBe('backend-local');
  });

  it('accepts exactly one deadline scheduler owner mode', () => {
    expect(
      validateEnv({
        BACKEND_DEADLINE_WORKER_SCHEDULER_OWNER: 'in_process',
      }).BACKEND_DEADLINE_WORKER_SCHEDULER_OWNER,
    ).toBe('in_process');

    expect(
      validateEnv({
        BACKEND_DEADLINE_WORKER_SCHEDULER_OWNER: 'external',
      }).BACKEND_DEADLINE_WORKER_SCHEDULER_OWNER,
    ).toBe('external');

    expect(() =>
      validateEnv({
        BACKEND_DEADLINE_WORKER_SCHEDULER_OWNER: 'both',
      }),
    ).toThrow(/BACKEND_DEADLINE_WORKER_SCHEDULER_OWNER/);
  });

  it('keeps worker actions and notifications disabled when manual worker processing is enabled', () => {
    expect(
      validateEnv({
        BACKEND_ENABLE_DEADLINES: 'true',
        BACKEND_DEADLINES_READ_ONLY: 'false',
        BACKEND_ENABLE_DEADLINE_WORKER: 'true',
      }),
    ).toMatchObject({
      BACKEND_ENABLE_DEADLINES: true,
      BACKEND_DEADLINES_READ_ONLY: false,
      BACKEND_ENABLE_DEADLINE_WORKER: true,
      BACKEND_DEADLINE_ACTIONS_ENABLED: false,
      BACKEND_DEADLINE_NOTIFICATIONS_ENABLED: false,
      BACKEND_DEADLINE_WORKER_POLL_INTERVAL_MS: 60000,
      BACKEND_DEADLINE_WORKER_BATCH_SIZE: 100,
      BACKEND_DEADLINE_WORKER_ID: 'backend-local',
    });
  });

  it('defaults notification engine flags to safe-off', () => {
    expect(validateEnv({})).toMatchObject({
      BACKEND_ENABLE_NOTIFICATION_ENGINE: false,
      BACKEND_NOTIFICATION_RULES_READ_ONLY: true,
      BACKEND_OUTBOX_RELAY_OWNER: 'none',
      BACKEND_OUTBOX_RELAY_POLL_INTERVAL_MS: 60000,
      BACKEND_OUTBOX_RELAY_BATCH_SIZE: 100,
      BACKEND_OUTBOX_RELAY_WORKER_ID: 'backend-local',
      BACKEND_OUTBOX_RELAY_MAX_ATTEMPTS: 10,
    });
  });

  it('requires DATABASE_URL when notification engine is enabled', () => {
    expect(() =>
      validateEnv({
        BACKEND_ENABLE_NOTIFICATION_ENGINE: 'true',
      }),
    ).toThrow(/DATABASE_URL is required when BACKEND_ENABLE_NOTIFICATION_ENGINE is true/);

    expect(
      validateEnv({
        BACKEND_ENABLE_NOTIFICATION_ENGINE: 'true',
        DATABASE_URL: 'postgres://erp_user:erp_password@localhost:5432/erp',
      }),
    ).toMatchObject({
      BACKEND_ENABLE_NOTIFICATION_ENGINE: true,
    });
  });

  it('requires DATABASE_URL when labels are enabled', () => {
    expect(() =>
      validateEnv({
        BACKEND_ENABLE_LABELS: 'true',
      }),
    ).toThrow(/DATABASE_URL is required when BACKEND_ENABLE_LABELS is true/);

    expect(
      validateEnv({
        BACKEND_ENABLE_LABELS: 'true',
        DATABASE_URL: 'postgres://erp_user:erp_password@localhost:5432/erp',
      }),
    ).toMatchObject({
      BACKEND_ENABLE_LABELS: true,
    });
  });

  it('requires DATABASE_URL when Twenty sync is enabled', () => {
    expect(() =>
      validateEnv({
        BACKEND_ENABLE_TWENTY_SYNC: 'true',
        TWENTY_SYNC_BASE_URL: 'http://twenty:3000',
        TWENTY_SYNC_API_KEY: 'k',
        // DATABASE_URL omitted on purpose
      }),
    ).toThrow(/DATABASE_URL is required when BACKEND_ENABLE_TWENTY_SYNC is true/);

    expect(
      validateEnv({
        BACKEND_ENABLE_TWENTY_SYNC: 'true',
        TWENTY_SYNC_BASE_URL: 'http://twenty:3000',
        TWENTY_SYNC_API_KEY: 'k',
        DATABASE_URL: 'postgres://erp_user:erp_password@localhost:5432/erp',
      }),
    ).toMatchObject({
      BACKEND_ENABLE_TWENTY_SYNC: true,
    });
  });

  it('pins WORKOS_API_BASE to workos.com over https (localhost http only for mocks)', () => {
    expect(validateEnv({})).toMatchObject({ WORKOS_API_BASE: 'https://api.workos.com' });
    expect(
      validateEnv({ WORKOS_API_BASE: 'https://api.workos.com' }).WORKOS_API_BASE,
    ).toBe('https://api.workos.com');
    expect(
      validateEnv({ WORKOS_API_BASE: 'http://localhost:8787' }).WORKOS_API_BASE,
    ).toBe('http://localhost:8787');

    // A loose value would be an open redirect AND would receive the client
    // secret + one-time code from the server-side exchange.
    expect(() => validateEnv({ WORKOS_API_BASE: 'https://evil.example.com' })).toThrow(
      /workos\.com/,
    );
    expect(() => validateEnv({ WORKOS_API_BASE: 'http://api.workos.com' })).toThrow(
      /workos\.com/,
    );
    expect(() => validateEnv({ WORKOS_API_BASE: 'https://api.workos.com.evil.example' })).toThrow(
      /workos\.com/,
    );

    // Loopback mocks are for local development only.
    expect(() =>
      validateEnv({ NODE_ENV: 'production', FRONTEND_ORIGIN: 'https://app.example', WORKOS_API_BASE: 'http://localhost:8787' }),
    ).toThrow(/staging\/production/);
    expect(() =>
      validateEnv({ NODE_ENV: 'staging', WORKOS_API_BASE: 'http://127.0.0.1:8787' }),
    ).toThrow(/staging\/production/);
  });

  it('accepts empty-string WORKOS creds when WorkOS auth is disabled (compose injects ""→undefined)', () => {
    // docker-compose.vps.yml always sets `WORKOS_API_KEY: ${WORKOS_API_KEY:-}`,
    // so an unset var reaches the backend as "" (not undefined). With WorkOS
    // disabled this must NOT crash env validation — regression for the
    // deploy-blocking crash-loop after the 055 WorkOS merge.
    const parsed = validateEnv({
      BACKEND_ENABLE_WORKOS_AUTH: 'false',
      WORKOS_API_KEY: '',
      WORKOS_CLIENT_ID: '',
      WORKOS_REDIRECT_URI: '',
    });
    expect(parsed.WORKOS_API_KEY).toBeUndefined();
    expect(parsed.WORKOS_CLIENT_ID).toBeUndefined();
    expect(parsed.WORKOS_REDIRECT_URI).toBeUndefined();

    // But empty creds while WorkOS is ENABLED must still be rejected.
    expect(() =>
      validateEnv({
        BACKEND_ENABLE_AUTH: 'true',
        BACKEND_ENABLE_WORKOS_AUTH: 'true',
        WORKOS_API_KEY: '',
        WORKOS_CLIENT_ID: '',
        WORKOS_REDIRECT_URI: '',
      }),
    ).toThrow(/WORKOS_API_KEY is required when BACKEND_ENABLE_WORKOS_AUTH is true/);
  });
});
