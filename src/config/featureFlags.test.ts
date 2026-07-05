import { describe, expect, it } from 'vitest';
import {
  applyFeatureFlags,
  featureFlags,
  getFeatureFlags,
  mergeRuntimeFeatureFlags,
  readBooleanFlag,
  readOptionalBooleanFlag,
} from './featureFlags';

describe('featureFlags', () => {
  it('defaults backend flows off and legacy Hasura on', () => {
    expect(getFeatureFlags({})).toEqual({
      useBackendAuth: false,
      useBackendPermissions: false,
      useBackendOrdersRead: false,
      useBackendOrdersWrite: false,
      useBackendPayments: false,
      useBackendClientPhones: false,
      useBackendProductionActions: false,
      useBackendDeadlines: false,
      useBackendOrderExport: false,
      useBackendGroups: false,
      useBackendProjects: false,
      useBackendUsers: false,
      useBackendVlm: false,
      useBackendReferences: false,
      useBackendCut: false,
      labels: false,
      sheetMaterialsReads: false,
      enableLegacyHasura: true,
      workosAuth: false,
    });
  });

  it('reads the SP3 sheetMaterialsReads flag from env and runtime config, default off', () => {
    expect(getFeatureFlags({}).sheetMaterialsReads).toBe(false);
    expect(getFeatureFlags({ VITE_SHEET_MATERIALS_READS: 'true' }).sheetMaterialsReads).toBe(true);
    // runtime override (both the canonical key and the short alias)
    expect(getFeatureFlags({}, { sheetMaterialsReads: true }).sheetMaterialsReads).toBe(true);
    expect(getFeatureFlags({}, { sheetMaterials: true }).sheetMaterialsReads).toBe(true);
    // env true but runtime explicitly off -> off
    expect(
      getFeatureFlags({ VITE_SHEET_MATERIALS_READS: 'true' }, { sheetMaterials: false })
        .sheetMaterialsReads,
    ).toBe(false);
  });

  it('reads backend cut flag from env and runtime config with a safe default', () => {
    expect(getFeatureFlags({}).useBackendCut).toBe(false);
    expect(getFeatureFlags({ VITE_USE_BACKEND_CUT: 'true' }).useBackendCut).toBe(true);
    expect(
      getFeatureFlags({ VITE_USE_BACKEND_CUT: 'false' }, { backendCut: true }).useBackendCut,
    ).toBe(true);
  });

  it('reads labels flag from env and runtime config with a safe default', () => {
    expect(getFeatureFlags({}).labels).toBe(false);
    expect(getFeatureFlags({ VITE_USE_BACKEND_LABELS: 'true' }).labels).toBe(true);
    expect(getFeatureFlags({ VITE_USE_BACKEND_LABELS: 'false' }, { labels: true }).labels).toBe(true);
  });

  it('supports split read/write orders flags', () => {
    expect(
      getFeatureFlags({
        VITE_USE_BACKEND_ORDERS_READ: 'true',
        VITE_USE_BACKEND_ORDERS_WRITE: 'false',
      }),
    ).toMatchObject({
      useBackendOrdersRead: true,
      useBackendOrdersWrite: false,
    });
  });

  it('keeps backward compatibility with VITE_USE_BACKEND_ORDERS', () => {
    expect(getFeatureFlags({ VITE_USE_BACKEND_ORDERS: 'true' })).toMatchObject({
      useBackendOrdersRead: true,
      useBackendOrdersWrite: true,
    });
  });

  it('parses boolean-like values with fallback', () => {
    expect(readBooleanFlag('1', false)).toBe(true);
    expect(readBooleanFlag('off', true)).toBe(false);
    expect(readBooleanFlag(undefined, true)).toBe(true);
    expect(readBooleanFlag('unknown', false)).toBe(false);
  });

  it('overrides build-time flags from runtime config only for provided keys', () => {
    expect(
      getFeatureFlags(
        {
          VITE_USE_BACKEND_AUTH: 'false',
          VITE_USE_BACKEND_ORDERS_READ: 'true',
          VITE_USE_BACKEND_ORDERS_WRITE: 'true',
          VITE_USE_BACKEND_PAYMENTS: 'false',
          VITE_USE_BACKEND_GROUPS: 'false',
          VITE_USE_BACKEND_CLIENT_PHONES: 'false',
          VITE_USE_BACKEND_PRODUCTION_ACTIONS: 'false',
          VITE_USE_BACKEND_VLM: 'true',
        },
        {
          backendAuth: true,
          backendOrdersWrite: false,
          backendPayments: true,
          backendGroups: true,
          backendProjects: true,
          backendClientPhones: true,
          backendProductionActions: true,
        },
      ),
    ).toMatchObject({
      useBackendAuth: true,
      useBackendOrdersRead: true,
      useBackendOrdersWrite: false,
      useBackendPayments: true,
      useBackendGroups: true,
      useBackendProjects: true,
      useBackendClientPhones: true,
      useBackendProductionActions: true,
      useBackendVlm: true,
    });
  });

  it('supports runtime backendOrders compatibility flag for read and write', () => {
    expect(
      getFeatureFlags(
        {},
        {
          backendOrders: true,
        },
      ),
    ).toMatchObject({
      useBackendOrdersRead: true,
      useBackendOrdersWrite: true,
    });
  });

  it('fails closed for backend client phones until production actions are enabled', () => {
    expect(
      getFeatureFlags({
        VITE_USE_BACKEND_CLIENT_PHONES: 'true',
        VITE_USE_BACKEND_PRODUCTION_ACTIONS: 'false',
      }),
    ).toMatchObject({
      useBackendClientPhones: false,
      useBackendProductionActions: false,
    });

    expect(
      getFeatureFlags(
        { VITE_USE_BACKEND_PRODUCTION_ACTIONS: 'false' },
        { backendClientPhones: true },
      ),
    ).toMatchObject({
      useBackendClientPhones: false,
      useBackendProductionActions: false,
    });

    expect(
      getFeatureFlags(
        { VITE_USE_BACKEND_PRODUCTION_ACTIONS: 'true' },
        { backendClientPhones: true },
      ),
    ).toMatchObject({
      useBackendClientPhones: true,
      useBackendProductionActions: true,
    });
  });

  it('reads backend deadline flag from env and runtime config', () => {
    expect(
      getFeatureFlags({
        VITE_USE_BACKEND_AUTH: 'true',
        VITE_USE_BACKEND_ORDERS_READ: 'true',
        VITE_USE_BACKEND_DEADLINES: 'true',
      }).useBackendDeadlines,
    ).toBe(true);

    expect(
      getFeatureFlags(
        {
          VITE_USE_BACKEND_AUTH: 'true',
          VITE_USE_BACKEND_ORDERS_READ: 'true',
          VITE_USE_BACKEND_DEADLINES: 'false',
        },
        { backendDeadlines: true },
      ).useBackendDeadlines,
    ).toBe(true);
  });

  it('disables backend deadlines unless backend auth and orders read are enabled', () => {
    expect(
      getFeatureFlags({
        VITE_USE_BACKEND_DEADLINES: 'true',
        VITE_USE_BACKEND_AUTH: 'false',
        VITE_USE_BACKEND_ORDERS_READ: 'true',
      }).useBackendDeadlines,
    ).toBe(false);

    expect(
      getFeatureFlags({
        VITE_USE_BACKEND_DEADLINES: 'true',
        VITE_USE_BACKEND_AUTH: 'true',
        VITE_USE_BACKEND_ORDERS_READ: 'false',
      }).useBackendDeadlines,
    ).toBe(false);
  });

  it('ignores invalid runtime boolean values and keeps fallback', () => {
    const fallback = getFeatureFlags({ VITE_USE_BACKEND_USERS: 'true' });

    expect(
      mergeRuntimeFeatureFlags(fallback, {
        backendUsers: 'not-a-boolean',
      }),
    ).toMatchObject({
      useBackendUsers: true,
    });
    expect(readOptionalBooleanFlag('not-a-boolean')).toBeUndefined();
  });

  it('reads backend groups from env and runtime config with a safe default', () => {
    expect(getFeatureFlags({}).useBackendGroups).toBe(false);
    expect(getFeatureFlags({ VITE_USE_BACKEND_GROUPS: 'true' }).useBackendGroups).toBe(true);
    expect(
      getFeatureFlags({ VITE_USE_BACKEND_GROUPS: 'false' }, { backendGroups: true }).useBackendGroups,
    ).toBe(true);
    expect(getFeatureFlags({ VITE_USE_BACKEND_GROUPS: 'true' }).useBackendProjects).toBe(true);
  });

  it('can update the exported featureFlags object in place', () => {
    const original = { ...featureFlags };

    applyFeatureFlags({ ...original, useBackendVlm: true });

    expect(featureFlags.useBackendVlm).toBe(true);
    applyFeatureFlags(original);
  });
});
