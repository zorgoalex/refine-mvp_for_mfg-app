import { describe, expect, it } from 'vitest';
import { buildFrontendRuntimeConfig, readBooleanEnv } from './frontend-runtime-config';

describe('frontend runtime config delivery', () => {
  it('fails closed when runtime env is absent', () => {
    expect(buildFrontendRuntimeConfig({})).toEqual({
      apiUrl: '',
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
        labels: false,
        enableLegacyHasura: true,
        workosAuth: false,
      },
    });
  });

  it('maps whitelisted runtime env keys into the frontend config shape', () => {
    expect(
      buildFrontendRuntimeConfig({
        RUNTIME_CONFIG_API_URL: ' https://api.example.test/ ',
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
        RUNTIME_CONFIG_ENABLE_LEGACY_HASURA: 'false',
        GAS_API_KEY: 'must-not-leak',
      }),
    ).toEqual({
      apiUrl: 'https://api.example.test',
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
        labels: false,
        enableLegacyHasura: false,
        workosAuth: false,
      },
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
