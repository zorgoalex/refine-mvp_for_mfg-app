export interface FrontendRuntimeConfigResponse {
  apiUrl: string;
  ui: {
    evolutionEnabled: boolean;
    forceLegacy: boolean;
  };
  features: {
    backendAuth: boolean;
    backendPermissions: boolean;
    backendOrdersRead: boolean;
    backendOrdersWrite: boolean;
    backendPayments: boolean;
    backendClientPhones: boolean;
    backendProductionActions: boolean;
    backendDeadlines: boolean;
    backendOrderExport: boolean;
    backendGroups: boolean;
    backendUsers: boolean;
    backendVlm: boolean;
    backendReferences: boolean;
    backendCut: boolean;
    bazisCut: boolean;
    projects: boolean;
    bazisImport: boolean;
    labels: boolean;
    orderStatusBoard: boolean;
    cncTelegram: boolean;
    pdfImportLayoutPatterns: boolean;
    enableLegacyHasura: boolean;
    workosAuth: boolean;
  };
}

type EnvSource = Record<string, string | undefined>;

const TRUE_VALUES = new Set(['true', '1', 'yes', 'on']);
const FALSE_VALUES = new Set(['false', '0', 'no', 'off']);

export function buildFrontendRuntimeConfig(
  env: EnvSource = process.env,
): FrontendRuntimeConfigResponse {
  const backendOrders = readBooleanEnv(env.RUNTIME_CONFIG_BACKEND_ORDERS, false);
  const backendProductionActions = readBooleanEnv(
    env.RUNTIME_CONFIG_BACKEND_PRODUCTION_ACTIONS,
    false,
  );
  const backendGroups = readBooleanEnv(env.RUNTIME_CONFIG_BACKEND_GROUPS, false);
  const backendClientPhones =
    readBooleanEnv(env.RUNTIME_CONFIG_BACKEND_CLIENT_PHONES, false) &&
    backendProductionActions;

  return {
    apiUrl: normalizeApiUrl(env.RUNTIME_CONFIG_API_URL),
    ui: {
      evolutionEnabled: readBooleanEnv(env.RUNTIME_CONFIG_UI_EVOLUTION, false),
      forceLegacy: readBooleanEnv(env.RUNTIME_CONFIG_UI_FORCE_LEGACY, false),
    },
    features: {
      backendAuth: readBooleanEnv(env.RUNTIME_CONFIG_BACKEND_AUTH, false),
      backendPermissions: readBooleanEnv(env.RUNTIME_CONFIG_BACKEND_PERMISSIONS, false),
      backendOrdersRead: readBooleanEnv(env.RUNTIME_CONFIG_BACKEND_ORDERS_READ, backendOrders),
      backendOrdersWrite: readBooleanEnv(env.RUNTIME_CONFIG_BACKEND_ORDERS_WRITE, backendOrders),
      backendPayments: readBooleanEnv(env.RUNTIME_CONFIG_BACKEND_PAYMENTS, false),
      backendClientPhones,
      backendProductionActions,
      backendDeadlines: readBooleanEnv(env.RUNTIME_CONFIG_BACKEND_DEADLINES, false),
      backendOrderExport: readBooleanEnv(env.RUNTIME_CONFIG_BACKEND_ORDER_EXPORT, false),
      backendGroups,
      backendUsers: readBooleanEnv(env.RUNTIME_CONFIG_BACKEND_USERS, false),
      backendVlm: readBooleanEnv(env.RUNTIME_CONFIG_BACKEND_VLM, false),
      backendReferences: readBooleanEnv(env.RUNTIME_CONFIG_BACKEND_REFERENCES, false),
      backendCut: readBooleanEnv(env.RUNTIME_CONFIG_BACKEND_CUT, false),
      bazisCut: readBooleanEnv(env.RUNTIME_CONFIG_BAZIS_CUT, false),
      projects: readBooleanEnv(env.RUNTIME_CONFIG_PROJECTS, false),
      bazisImport: readBooleanEnv(env.RUNTIME_CONFIG_BACKEND_BAZIS, false),
      labels: readBooleanEnv(env.RUNTIME_CONFIG_LABELS, false),
      orderStatusBoard: readBooleanEnv(env.RUNTIME_CONFIG_ORDER_STATUS_BOARD, false),
      cncTelegram: readBooleanEnv(env.RUNTIME_CONFIG_CNC_TELEGRAM, false),
      pdfImportLayoutPatterns: readBooleanEnv(
        env.RUNTIME_CONFIG_PDF_IMPORT_LAYOUT_PATTERNS,
        false,
      ),
      enableLegacyHasura: readBooleanEnv(env.RUNTIME_CONFIG_ENABLE_LEGACY_HASURA, true),
      workosAuth: readBooleanEnv(env.RUNTIME_CONFIG_WORKOS_AUTH, false),
    },
  };
}

export function readBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;

  const normalized = value.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;

  return fallback;
}

function normalizeApiUrl(value: string | undefined): string {
  if (value === undefined) return '';

  return value.trim().replace(/\/+$/, '');
}
