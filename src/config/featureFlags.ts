export interface FrontendFeatureFlags {
  useBackendAuth: boolean;
  useBackendPermissions: boolean;
  useBackendOrdersRead: boolean;
  useBackendOrdersWrite: boolean;
  useBackendOrderExport: boolean;
  useBackendUsers: boolean;
  useBackendVlm: boolean;
  useBackendReferences: boolean;
  enableLegacyHasura: boolean;
}

type EnvSource = Record<string, string | boolean | undefined>;

export function getFeatureFlags(
  env: EnvSource = (import.meta as { env?: EnvSource }).env ?? {},
): FrontendFeatureFlags {
  const legacyOrdersFlag = readBooleanFlag(env.VITE_USE_BACKEND_ORDERS, false);

  return {
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
    useBackendOrderExport: readBooleanFlag(env.VITE_USE_BACKEND_ORDER_EXPORT, false),
    useBackendUsers: readBooleanFlag(env.VITE_USE_BACKEND_USERS, false),
    useBackendVlm: readBooleanFlag(env.VITE_USE_BACKEND_VLM, false),
    useBackendReferences: readBooleanFlag(env.VITE_USE_BACKEND_REFERENCES, false),
    enableLegacyHasura: readBooleanFlag(env.VITE_ENABLE_LEGACY_HASURA, true),
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

export const featureFlags = getFeatureFlags();
