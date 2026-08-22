import { describe, expect, it } from 'vitest';
import { buildFrontendRuntimeConfig, readBooleanEnv } from './frontend-runtime-config';

describe('frontend runtime config delivery', () => {
  it('fails closed when runtime env is absent', () => {
    expect(buildFrontendRuntimeConfig({})).toEqual({
      apiUrl: '',
      build: { sha: '' },
      hasuraUrl: '',
      ui: {
        evolutionEnabled: false,
        forceLegacy: false,
      },
      features: {
        backendAuth: false,
        backendPermissions: false,
        backendOrdersRead: false,
        backendOrdersWrite: false,
        backendPayments: false,
        backendClientPhones: false,
        backendProductionActions: false,
        backendDeadlines: false,
        backendOrderExport: false,
        backendGroups: false,
        backendUsers: false,
        backendVlm: false,
        backendReferences: false,
        backendCut: false,
        bazisCut: false,
        labels: false,
        orderStatusBoard: false,
        orderRealtime: false,
        cncTelegram: false,
        pdfImportLayoutPatterns: false,
        projects: false,
        bazisImport: false,
        enableLegacyHasura: true,
        workosAuth: false,
      },
      observability: { performanceRum: false },
      rollouts: {
        orderLifecycleV2: {
          enabled: false,
          percent: 0,
          allocationSalt: '',
          configVersion: '',
        },
      },
    });
  });

  it('maps whitelisted runtime env keys into the frontend config shape', () => {
    expect(
      buildFrontendRuntimeConfig({
        RUNTIME_CONFIG_API_URL: ' https://api.example.test/ ',
        RUNTIME_CONFIG_HASURA_URL: ' https://hasura.example.test/v1/graphql/ ',
        RUNTIME_CONFIG_BACKEND_AUTH: 'true',
        RUNTIME_CONFIG_BACKEND_PERMISSIONS: '1',
        RUNTIME_CONFIG_BACKEND_ORDERS_READ: 'yes',
        RUNTIME_CONFIG_BACKEND_ORDERS_WRITE: 'on',
        RUNTIME_CONFIG_BACKEND_PAYMENTS: 'true',
        RUNTIME_CONFIG_BACKEND_CLIENT_PHONES: 'true',
        RUNTIME_CONFIG_BACKEND_PRODUCTION_ACTIONS: 'true',
        RUNTIME_CONFIG_BACKEND_DEADLINES: 'true',
        RUNTIME_CONFIG_BACKEND_ORDER_EXPORT: 'true',
        RUNTIME_CONFIG_BACKEND_GROUPS: 'true',
        RUNTIME_CONFIG_BACKEND_USERS: 'true',
        RUNTIME_CONFIG_BACKEND_VLM: 'true',
        RUNTIME_CONFIG_BACKEND_REFERENCES: 'false',
        RUNTIME_CONFIG_BAZIS_CUT: 'true',
        RUNTIME_CONFIG_ORDER_STATUS_BOARD: 'true',
        RUNTIME_CONFIG_ORDER_REALTIME: 'true',
        RUNTIME_CONFIG_CNC_TELEGRAM: 'true',
        RUNTIME_CONFIG_ENABLE_LEGACY_HASURA: 'false',
        RUNTIME_CONFIG_BUILD_SHA: 'abcdef123456',
        RUNTIME_CONFIG_PERFORMANCE_RUM: 'true',
        RUNTIME_CONFIG_ORDER_LIFECYCLE_ENABLED: 'true',
        RUNTIME_CONFIG_ORDER_LIFECYCLE_PERCENT: '25',
        RUNTIME_CONFIG_ORDER_LIFECYCLE_SALT: 'salt-v1',
        RUNTIME_CONFIG_ORDER_LIFECYCLE_VERSION: 'lifecycle-v1',
        GAS_API_KEY: 'must-not-leak',
      }),
    ).toEqual({
      apiUrl: 'https://api.example.test',
      build: { sha: 'abcdef123456' },
      hasuraUrl: 'https://hasura.example.test/v1/graphql',
      ui: {
        evolutionEnabled: false,
        forceLegacy: false,
      },
      features: {
        backendAuth: true,
        backendPermissions: true,
        backendOrdersRead: true,
        backendOrdersWrite: true,
        backendPayments: true,
        backendClientPhones: true,
        backendProductionActions: true,
        backendDeadlines: true,
        backendOrderExport: true,
        backendGroups: true,
        backendUsers: true,
        backendVlm: true,
        backendReferences: false,
        backendCut: false,
        bazisCut: true,
        labels: false,
        orderStatusBoard: true,
        orderRealtime: true,
        cncTelegram: true,
        pdfImportLayoutPatterns: false,
        projects: false,
        bazisImport: false,
        enableLegacyHasura: false,
        workosAuth: false,
      },
      observability: { performanceRum: true },
      rollouts: {
        orderLifecycleV2: {
          enabled: true,
          percent: 25,
          allocationSalt: 'salt-v1',
          configVersion: 'lifecycle-v1',
        },
      },
    });
  });

  it('fails lifecycle rollout closed when required allocation fields are invalid', () => {
    expect(buildFrontendRuntimeConfig({
      RUNTIME_CONFIG_ORDER_LIFECYCLE_ENABLED: 'true',
      RUNTIME_CONFIG_ORDER_LIFECYCLE_PERCENT: '101',
      RUNTIME_CONFIG_ORDER_LIFECYCLE_SALT: 'contains spaces',
      RUNTIME_CONFIG_ORDER_LIFECYCLE_VERSION: 'v1',
    }).rollouts.orderLifecycleV2).toEqual({
      enabled: false,
      percent: 0,
      allocationSalt: '',
      configVersion: '',
    });
  });

  it('supports a runtime backendOrders shortcut with split flag override', () => {
    expect(
      buildFrontendRuntimeConfig({
        RUNTIME_CONFIG_BACKEND_ORDERS: 'true',
        RUNTIME_CONFIG_BACKEND_ORDERS_WRITE: 'false',
      }).features,
    ).toMatchObject({
      backendOrdersRead: true,
      backendOrdersWrite: false,
    });
  });

  it('maps labels runtime flag default-off and true', () => {
    expect(buildFrontendRuntimeConfig({}).features.labels).toBe(false);
    expect(buildFrontendRuntimeConfig({ RUNTIME_CONFIG_LABELS: 'true' }).features.labels).toBe(true);
  });

  it('maps UI rollout flags and keeps force-legacy independent', () => {
    expect(buildFrontendRuntimeConfig({}).ui).toEqual({
      evolutionEnabled: false,
      forceLegacy: false,
    });
    expect(buildFrontendRuntimeConfig({
      RUNTIME_CONFIG_UI_EVOLUTION: 'true',
      RUNTIME_CONFIG_UI_FORCE_LEGACY: 'true',
    }).ui).toEqual({
      evolutionEnabled: true,
      forceLegacy: true,
    });
  });

  it('maps PDF layout-pattern runtime flag default-off and true', () => {
    expect(buildFrontendRuntimeConfig({}).features.pdfImportLayoutPatterns).toBe(false);
    expect(buildFrontendRuntimeConfig({
      RUNTIME_CONFIG_PDF_IMPORT_LAYOUT_PATTERNS: 'true',
    }).features.pdfImportLayoutPatterns).toBe(true);
  });

  it('maps CNC Telegram runtime flag default-off and true', () => {
    expect(buildFrontendRuntimeConfig({}).features.cncTelegram).toBe(false);
    expect(buildFrontendRuntimeConfig({
      RUNTIME_CONFIG_CNC_TELEGRAM: 'true',
    }).features.cncTelegram).toBe(true);
  });

  it('maps order realtime runtime flag default-off and true', () => {
    expect(buildFrontendRuntimeConfig({}).features.orderRealtime).toBe(false);
    expect(buildFrontendRuntimeConfig({
      RUNTIME_CONFIG_ORDER_REALTIME: 'true',
    }).features.orderRealtime).toBe(true);
  });

  it('maps projects runtime flag default-off and true', () => {
    expect(buildFrontendRuntimeConfig({}).features.projects).toBe(false);
    expect(buildFrontendRuntimeConfig({ RUNTIME_CONFIG_PROJECTS: 'true' }).features.projects).toBe(true);
  });

  it('maps Bazis cut runtime flag default-off, explicit off, and on', () => {
    expect(buildFrontendRuntimeConfig({}).features.bazisCut).toBe(false);
    expect(
      buildFrontendRuntimeConfig({ RUNTIME_CONFIG_BAZIS_CUT: 'false' }).features.bazisCut,
    ).toBe(false);
    expect(
      buildFrontendRuntimeConfig({ RUNTIME_CONFIG_BAZIS_CUT: 'true' }).features.bazisCut,
    ).toBe(true);
  });

  it('fails closed for backend client phones until production actions are enabled', () => {
    expect(
      buildFrontendRuntimeConfig({
        RUNTIME_CONFIG_BACKEND_CLIENT_PHONES: 'true',
        RUNTIME_CONFIG_BACKEND_PRODUCTION_ACTIONS: 'false',
      }).features,
    ).toMatchObject({
      backendClientPhones: false,
      backendProductionActions: false,
    });

    expect(
      buildFrontendRuntimeConfig({
        RUNTIME_CONFIG_BACKEND_CLIENT_PHONES: 'true',
        RUNTIME_CONFIG_BACKEND_PRODUCTION_ACTIONS: 'true',
      }).features,
    ).toMatchObject({
      backendClientPhones: true,
      backendProductionActions: true,
    });
  });

  it('keeps invalid boolean values at the safe fallback', () => {
    expect(readBooleanEnv('unexpected', false)).toBe(false);
    expect(readBooleanEnv('unexpected', true)).toBe(true);
    expect(readBooleanEnv('off', true)).toBe(false);
    expect(readBooleanEnv('', true)).toBe(true);
  });
});
