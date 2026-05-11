export interface FrontendFeatureFlags {
  useBackendAuth: boolean;
  useBackendPermissions: boolean;
  useBackendOrdersRead: boolean;
  useBackendOrdersWrite: boolean;
  useBackendPayments: boolean;
  useBackendProductionActions: boolean;
  useBackendOrderExport: boolean;
  useBackendUsers: boolean;
  useBackendVlm: boolean;
  useBackendReferences: boolean;
  enableLegacyHasura: boolean;
}

type EnvSource = Record<string, string | boolean | undefined>;
export type RuntimeFeatureFlagSource = Partial<{
  backendAuth: string | boolean;
  backendPermissions: string | boolean;
  backendOrders: string | boolean;
  backendOrdersRead: string | boolean;
  backendOrdersWrite: string | boolean;
  backendPayments: string | boolean;
  backendProductionActions: string | boolean;
  backendOrderExport: string | boolean;
  backendUsers: string | boolean;
  backendVlm: string | boolean;
  backendReferences: string | boolean;
  enableLegacyHasura: string | boolean;
  legacyHasura: string | boolean;
}>;

export function getFeatureFlags(
  env: EnvSource = (import.meta as { env?: EnvSource }).env ?? {},
  runtimeFeatures: RuntimeFeatureFlagSource = {},
): FrontendFeatureFlags {
  const legacyOrdersFlag = readBooleanFlag(env.VITE_USE_BACKEND_ORDERS, false);
  const envFlags: FrontendFeatureFlags = {
    useBackendAuth: readBooleanFlag(env.VITE_USE_BACKEND_AUTH, false),
    useBackendPermissions: readBooleanFlag(env.VITE_USE_BACKEND_PERMISSIONS, false),
    useBackendOrdersRead: readBooleanFlag(
      env.VITE_USE_BACKEND_ORDERS_READ,
      legacyOrdersFlag,
    ),
    useBackendOrdersWrite: readBooleanFlag(
      env.VITE_USE_BACKEND_ORDERS_WRITE,
      legacyOrdersFlag,
    ),
    useBackendPayments: readBooleanFlag(env.VITE_USE_BACKEND_PAYMENTS, false),
    useBackendProductionActions: readBooleanFlag(
      env.VITE_USE_BACKEND_PRODUCTION_ACTIONS,
      false,
    ),
    useBackendOrderExport: readBooleanFlag(env.VITE_USE_BACKEND_ORDER_EXPORT, false),
    useBackendUsers: readBooleanFlag(env.VITE_USE_BACKEND_USERS, false),
    useBackendVlm: readBooleanFlag(env.VITE_USE_BACKEND_VLM, false),
    useBackendReferences: readBooleanFlag(env.VITE_USE_BACKEND_REFERENCES, false),
    enableLegacyHasura: readBooleanFlag(env.VITE_ENABLE_LEGACY_HASURA, true),
  };

  return mergeRuntimeFeatureFlags(envFlags, runtimeFeatures);
}

export function mergeRuntimeFeatureFlags(
  fallback: FrontendFeatureFlags,
  runtimeFeatures: RuntimeFeatureFlagSource = {},
): FrontendFeatureFlags {
  const runtimeOrdersFlag = readOptionalBooleanFlag(runtimeFeatures.backendOrders);

  return {
    useBackendAuth: readOptionalBooleanFlag(runtimeFeatures.backendAuth) ?? fallback.useBackendAuth,
    useBackendPermissions:
      readOptionalBooleanFlag(runtimeFeatures.backendPermissions) ?? fallback.useBackendPermissions,
    useBackendOrdersRead:
      readOptionalBooleanFlag(runtimeFeatures.backendOrdersRead) ??
      runtimeOrdersFlag ??
      fallback.useBackendOrdersRead,
    useBackendOrdersWrite:
      readOptionalBooleanFlag(runtimeFeatures.backendOrdersWrite) ??
      runtimeOrdersFlag ??
      fallback.useBackendOrdersWrite,
    useBackendPayments:
      readOptionalBooleanFlag(runtimeFeatures.backendPayments) ?? fallback.useBackendPayments,
    useBackendProductionActions:
      readOptionalBooleanFlag(runtimeFeatures.backendProductionActions) ??
      fallback.useBackendProductionActions,
    useBackendOrderExport:
      readOptionalBooleanFlag(runtimeFeatures.backendOrderExport) ?? fallback.useBackendOrderExport,
    useBackendUsers: readOptionalBooleanFlag(runtimeFeatures.backendUsers) ?? fallback.useBackendUsers,
    useBackendVlm: readOptionalBooleanFlag(runtimeFeatures.backendVlm) ?? fallback.useBackendVlm,
    useBackendReferences:
      readOptionalBooleanFlag(runtimeFeatures.backendReferences) ?? fallback.useBackendReferences,
    enableLegacyHasura:
      readOptionalBooleanFlag(runtimeFeatures.enableLegacyHasura) ??
      readOptionalBooleanFlag(runtimeFeatures.legacyHasura) ??
      fallback.enableLegacyHasura,
  };
}

export function readBooleanFlag(value: string | boolean | undefined, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === '') return fallback;

  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;

  return fallback;
}

export function readOptionalBooleanFlag(value: string | boolean | undefined): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === '') return undefined;

  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off'].includes(normalized)) return false;

  return undefined;
}

export const featureFlags = getFeatureFlags();

export function applyFeatureFlags(nextFlags: FrontendFeatureFlags): FrontendFeatureFlags {
  Object.assign(featureFlags, nextFlags);
  return featureFlags;
}
