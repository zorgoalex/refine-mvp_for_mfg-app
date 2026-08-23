export interface FrontendRuntimeConfigResponse {
  apiUrl: string;
  build: {
    sha: string;
  };
  hasuraUrl: string;
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
    orderRealtime: boolean;
    cncTelegram: boolean;
    pdfImportLayoutPatterns: boolean;
    enableLegacyHasura: boolean;
    workosAuth: boolean;
  };
  observability: {
    performanceRum: boolean;
  };
  rollouts: {
    orderLifecycleV2: {
      enabled: boolean;
      percent: number;
      allocationSalt: string;
      configVersion: string;
    };
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
    build: {
      sha: normalizeBuildSha(env.RUNTIME_CONFIG_BUILD_SHA ?? env.VERCEL_GIT_COMMIT_SHA),
    },
    hasuraUrl: normalizeApiUrl(env.RUNTIME_CONFIG_HASURA_URL),
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
      orderRealtime: readBooleanEnv(env.RUNTIME_CONFIG_ORDER_REALTIME, false),
      cncTelegram: readBooleanEnv(env.RUNTIME_CONFIG_CNC_TELEGRAM, false),
      pdfImportLayoutPatterns: readBooleanEnv(
        env.RUNTIME_CONFIG_PDF_IMPORT_LAYOUT_PATTERNS,
        false,
      ),
      enableLegacyHasura: readBooleanEnv(env.RUNTIME_CONFIG_ENABLE_LEGACY_HASURA, true),
      workosAuth: readBooleanEnv(env.RUNTIME_CONFIG_WORKOS_AUTH, false),
    },
    observability: {
      performanceRum: readBooleanEnv(env.RUNTIME_CONFIG_PERFORMANCE_RUM, false),
    },
    rollouts: {
      orderLifecycleV2: buildOrderLifecycleRollout(env),
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

function normalizeBuildSha(value: string | undefined): string {
  const normalized = value?.trim() ?? '';
  return /^[a-zA-Z0-9._-]{7,64}$/.test(normalized) ? normalized : '';
}

function buildOrderLifecycleRollout(env: EnvSource) {
  const enabled = readBooleanEnv(env.RUNTIME_CONFIG_ORDER_LIFECYCLE_ENABLED, false);
  const percent = readRolloutPercent(env.RUNTIME_CONFIG_ORDER_LIFECYCLE_PERCENT);
  const allocationSalt = normalizeRolloutToken(env.RUNTIME_CONFIG_ORDER_LIFECYCLE_SALT);
  const configVersion = normalizeRolloutToken(env.RUNTIME_CONFIG_ORDER_LIFECYCLE_VERSION);

  if (!enabled || !allocationSalt || !configVersion) {
    return { enabled: false, percent: 0, allocationSalt: '', configVersion: '' };
  }

  return { enabled: true, percent, allocationSalt, configVersion };
}

function readRolloutPercent(value: string | undefined): number {
  if (value === undefined || value.trim() === '') return 0;
  const percent = Number(value);
  return Number.isInteger(percent) && percent >= 0 && percent <= 100 ? percent : 0;
}

function normalizeRolloutToken(value: string | undefined): string {
  const normalized = value?.trim() ?? '';
  return /^[a-zA-Z0-9._-]{1,64}$/.test(normalized) ? normalized : '';
}
