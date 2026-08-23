import {
  applyFeatureFlags,
  getFeatureFlags,
  type RuntimeFeatureFlagSource,
} from './featureFlags';

export interface FrontendRuntimeConfig {
  apiUrl?: string | null;
  build?: FrontendBuildRuntimeConfig | null;
  hasuraUrl?: string | null;
  features?: RuntimeFeatureFlagSource | null;
  ui?: FrontendUiRuntimeConfig | null;
  observability?: FrontendObservabilityRuntimeConfig | null;
  rollouts?: FrontendRolloutsRuntimeConfig | null;
}

export interface FrontendBuildRuntimeConfig {
  sha?: string;
}

export interface FrontendObservabilityRuntimeConfig {
  performanceRum?: boolean;
}

export interface OrderLifecycleRuntimeConfig {
  enabled: boolean;
  percent: number;
  allocationSalt: string;
  configVersion: string;
}

export interface FrontendRolloutsRuntimeConfig {
  orderLifecycleV2?: OrderLifecycleRuntimeConfig | null;
}

export interface FrontendUiRuntimeConfig {
  evolutionEnabled?: boolean;
  forceLegacy?: boolean;
}

export interface InitializeRuntimeConfigOptions {
  url?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | boolean | undefined>;
}

const DEFAULT_RUNTIME_CONFIG_URL = '/runtime-config.json';
const DEFAULT_RUNTIME_CONFIG_TIMEOUT_MS = 1500;

let runtimeApiUrl: string | null = null;
let runtimeHasuraUrl: string | null = null;
let loadedRuntimeConfig: FrontendRuntimeConfig | null = null;

export async function initializeRuntimeConfig(
  options: InitializeRuntimeConfigOptions = {},
): Promise<FrontendRuntimeConfig | null> {
  const env = options.env ?? (import.meta as { env?: Record<string, string | boolean | undefined> }).env ?? {};
  const config = await fetchRuntimeConfig({
    url: options.url ?? getRuntimeConfigUrl(env),
    timeoutMs: options.timeoutMs ?? DEFAULT_RUNTIME_CONFIG_TIMEOUT_MS,
    fetchImpl: options.fetchImpl,
  });

  applyRuntimeConfig(config, env);
  return config;
}

export function applyRuntimeConfig(
  config: FrontendRuntimeConfig | null,
  env: Record<string, string | boolean | undefined> =
    (import.meta as { env?: Record<string, string | boolean | undefined> }).env ?? {},
): void {
  loadedRuntimeConfig = config;
  runtimeApiUrl = normalizeApiUrl(config?.apiUrl);
  runtimeHasuraUrl = normalizeApiUrl(config?.hasuraUrl);
  applyFeatureFlags(getFeatureFlags(env, config?.features ?? {}));
}

export function getRuntimeApiUrl(): string | null {
  return runtimeApiUrl;
}

export function getRuntimeHasuraUrl(): string | null {
  return runtimeHasuraUrl;
}

export function getLoadedRuntimeConfig(): FrontendRuntimeConfig | null {
  return loadedRuntimeConfig;
}

export function resetRuntimeConfigForTests(
  env: Record<string, string | boolean | undefined> = {},
): void {
  loadedRuntimeConfig = null;
  runtimeApiUrl = null;
  runtimeHasuraUrl = null;
  applyFeatureFlags(getFeatureFlags(env));
}

async function fetchRuntimeConfig(input: {
  url: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}): Promise<FrontendRuntimeConfig | null> {
  if (!input.url) return null;

  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  if (!fetchImpl) return null;

  const controller = typeof AbortController !== 'undefined'
    ? new AbortController()
    : null;
  const timeout = controller
    ? setTimeout(() => controller.abort(), input.timeoutMs)
    : null;

  try {
    const response = await fetchImpl(input.url, {
      cache: 'no-store',
      headers: { Accept: 'application/json' },
      signal: controller?.signal,
    });

    if (response.status === 404 || !response.ok) {
      return null;
    }

    const body = await response.json().catch(() => null);
    return isRuntimeConfig(body) ? body : null;
  } catch {
    return null;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function getRuntimeConfigUrl(env: Record<string, string | boolean | undefined>): string {
  const value = env.VITE_RUNTIME_CONFIG_URL;
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : DEFAULT_RUNTIME_CONFIG_URL;
}

function normalizeApiUrl(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;

  const trimmed = value.trim().replace(/\/+$/, '');
  return trimmed || null;
}

function isRuntimeConfig(value: unknown): value is FrontendRuntimeConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const config = value as FrontendRuntimeConfig;
  const apiUrlIsValid =
    config.apiUrl === undefined ||
    config.apiUrl === null ||
    typeof config.apiUrl === 'string';
  const hasuraUrlIsValid =
    config.hasuraUrl === undefined ||
    config.hasuraUrl === null ||
    typeof config.hasuraUrl === 'string';
  const featuresAreValid =
    config.features === undefined ||
    config.features === null ||
    (typeof config.features === 'object' && !Array.isArray(config.features));
  const buildIsValid =
    config.build === undefined ||
    config.build === null ||
    (typeof config.build === 'object' &&
      !Array.isArray(config.build) &&
      (config.build.sha === undefined ||
        (typeof config.build.sha === 'string' && /^[a-zA-Z0-9._-]{0,64}$/.test(config.build.sha))));
  const uiIsValid =
    config.ui === undefined ||
    config.ui === null ||
    (typeof config.ui === 'object' &&
      !Array.isArray(config.ui) &&
      (config.ui.evolutionEnabled === undefined || typeof config.ui.evolutionEnabled === 'boolean') &&
      (config.ui.forceLegacy === undefined || typeof config.ui.forceLegacy === 'boolean'));
  const observabilityIsValid =
    config.observability === undefined ||
    config.observability === null ||
    (typeof config.observability === 'object' &&
      !Array.isArray(config.observability) &&
      (config.observability.performanceRum === undefined ||
        typeof config.observability.performanceRum === 'boolean'));
  const rolloutsAreValid = validateRollouts(config.rollouts);

  return apiUrlIsValid && hasuraUrlIsValid && buildIsValid && featuresAreValid && uiIsValid &&
    observabilityIsValid && rolloutsAreValid;
}

function validateRollouts(value: FrontendRolloutsRuntimeConfig | null | undefined): boolean {
  if (value === undefined || value === null) return true;
  if (typeof value !== 'object' || Array.isArray(value)) return false;
  const rollout = value.orderLifecycleV2;
  if (rollout === undefined || rollout === null) return true;
  if (typeof rollout !== 'object' || Array.isArray(rollout)) return false;
  return typeof rollout.enabled === 'boolean' &&
    Number.isInteger(rollout.percent) && rollout.percent >= 0 && rollout.percent <= 100 &&
    typeof rollout.allocationSalt === 'string' &&
    /^[a-zA-Z0-9._-]{0,64}$/.test(rollout.allocationSalt) &&
    typeof rollout.configVersion === 'string' &&
    /^[a-zA-Z0-9._-]{0,64}$/.test(rollout.configVersion) &&
    (!rollout.enabled || (rollout.allocationSalt.length > 0 && rollout.configVersion.length > 0));
}
