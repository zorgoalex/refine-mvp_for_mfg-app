import { authApi } from '../api/authApi';
import { authSession } from '../api/authSession';
import { profileApi } from '../api/profileApi';
import { featureFlags } from '../config/featureFlags';
import type { FrontendUiRuntimeConfig } from '../config/runtimeConfig';
import { isTabletDevice } from '../hooks/useDeviceTier';
import { getStoredTabletMode, setStoredTabletMode } from '../theme/themeStorage';
import { authStorage } from '../utils/auth';
import { isModernUiAvailable, isUiVariant, resolveUiVariant, type UiVariant } from './uiVariant';
import { getStoredUiVariant, setStoredUiVariant } from './uiVariantStorage';

const DEFAULT_UI_VARIANT_BOOTSTRAP_TIMEOUT_MS = 2500;

interface UiVariantPreferenceResponse {
  preferences?: {
    uiVariant?: unknown;
    tabletMode?: unknown;
  };
}

export interface UiVariantBootstrapDependencies {
  restoreSession: () => Promise<void>;
  getCurrentUserId: () => string | null;
  hasAccessToken: () => boolean;
  getPreferences: () => Promise<UiVariantPreferenceResponse>;
  getCached: (userId: string) => UiVariant | null;
  setCached: (userId: string, variant: UiVariant) => void;
  getTabletModeCached: (userId: string) => boolean | null;
  setTabletModeCached: (userId: string, enabled: boolean) => void;
  isTabletDevice?: () => boolean;
  now?: () => number;
  timeoutMs?: number;
}

export async function resolveInitialUiVariant(
  config: FrontendUiRuntimeConfig | null | undefined,
  dependencies: UiVariantBootstrapDependencies = defaultDependencies(),
): Promise<UiVariant> {
  if (!isModernUiAvailable(config)) return resolveUiVariant(config);
  if ((dependencies.isTabletDevice ?? isTabletDevice)()) return 'evolution';

  const now = dependencies.now ?? Date.now;
  const deadline = now() + (
    dependencies.timeoutMs ?? DEFAULT_UI_VARIANT_BOOTSTRAP_TIMEOUT_MS
  );

  try {
    await withinDeadline(dependencies.restoreSession(), deadline, now);
  } catch {
    return resolveUiVariant(config);
  }

  const userId = dependencies.getCurrentUserId();
  if (!userId || !dependencies.hasAccessToken()) {
    return resolveUiVariant(config);
  }

  const cached = dependencies.getCached(userId);
  const cachedTabletMode = dependencies.getTabletModeCached(userId);

  try {
    const response = await withinDeadline(
      dependencies.getPreferences(),
      deadline,
      now,
    );
    const confirmed = response.preferences?.uiVariant;
    const confirmedTabletMode = response.preferences?.tabletMode;
    if (
      dependencies.getCurrentUserId() === userId &&
      typeof confirmedTabletMode === 'boolean'
    ) {
      dependencies.setTabletModeCached(userId, confirmedTabletMode);
    }
    if (
      dependencies.getCurrentUserId() === userId &&
      (confirmedTabletMode === true || (confirmedTabletMode === undefined && cachedTabletMode === true))
    ) {
      return 'evolution';
    }
    if (
      dependencies.getCurrentUserId() === userId &&
      isUiVariant(confirmed)
    ) {
      dependencies.setCached(userId, confirmed);
      return resolveUiVariant(config, confirmed);
    }
    // A successful old/malformed backend response is authoritative absence,
    // not a transport outage. Use the configured default instead of stale cache.
    return resolveUiVariant(config);
  } catch {
    // Same-user confirmed cache is the only non-server bootstrap fallback.
  }

  if (dependencies.getCurrentUserId() !== userId) {
    return resolveUiVariant(config);
  }
  if (cachedTabletMode === true) return 'evolution';
  return resolveUiVariant(config, cached);
}

export function seedLegacyAuthSession(): void {
  if (featureFlags.useBackendAuth) return;

  const user = authStorage.getUser();
  const accessToken = authStorage.getAccessToken();
  if (user) authSession.setUser(user);
  if (accessToken) authSession.setAccessToken(accessToken);
}

function defaultDependencies(): UiVariantBootstrapDependencies {
  return {
    restoreSession: restoreBootstrapSession,
    getCurrentUserId: () => {
      const id = authStorage.getUser()?.id;
      return id === undefined || id === null ? null : String(id);
    },
    hasAccessToken: () => Boolean(authStorage.getAccessToken()),
    getPreferences: () => profileApi.getPreferences(),
    getCached: getStoredUiVariant,
    setCached: setStoredUiVariant,
    getTabletModeCached: getStoredTabletMode,
    setTabletModeCached: setStoredTabletMode,
  };
}

async function restoreBootstrapSession(): Promise<void> {
  if (featureFlags.useBackendAuth) {
    if (!authSession.getAccessToken()) {
      await authApi.refresh();
    }
  }
}

async function withinDeadline<T>(
  promise: Promise<T>,
  deadline: number,
  now: () => number,
): Promise<T> {
  const remainingMs = deadline - now();
  if (remainingMs <= 0) throw new Error('UI variant bootstrap timed out');

  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error('UI variant bootstrap timed out')),
          remainingMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
