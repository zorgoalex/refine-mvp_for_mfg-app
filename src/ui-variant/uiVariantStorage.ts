import { isUiVariant, type UiVariant } from './uiVariant';

const UI_VARIANT_STORAGE_PREFIX = 'erp.uiVariant.';

export function uiVariantStorageKey(userId: string): string {
  return `${UI_VARIANT_STORAGE_PREFIX}${userId}`;
}

export function getStoredUiVariant(
  userId: string,
  storage: Pick<Storage, 'getItem'> = localStorage,
): UiVariant | null {
  try {
    const value = storage.getItem(uiVariantStorageKey(userId));
    return isUiVariant(value) ? value : null;
  } catch {
    return null;
  }
}

export function setStoredUiVariant(
  userId: string,
  variant: UiVariant,
  storage: Pick<Storage, 'setItem'> = localStorage,
): void {
  try {
    storage.setItem(uiVariantStorageKey(userId), variant);
  } catch {
    // Storage can be unavailable in private/locked-down browser contexts.
  }
}

/**
 * Device-level hint for screens shown before sign-in (the login page). Only the
 * NewLine choice is kept: every other variant shares the same login screen.
 * It never decides the shell of a signed-in user — that is always the per-user
 * preference above.
 */
const UI_VARIANT_DEVICE_HINT_KEY = 'erp.uiVariant.device';

export function getDeviceUiVariantHint(
  storage?: Pick<Storage, 'getItem'>,
): 'workbench' | null {
  try {
    // the global getter itself throws when site data is blocked
    const target = storage ?? localStorage;
    return target.getItem(UI_VARIANT_DEVICE_HINT_KEY) === 'workbench' ? 'workbench' : null;
  } catch {
    return null;
  }
}

export function setDeviceUiVariantHint(
  variant: UiVariant,
  storage?: Pick<Storage, 'setItem' | 'removeItem'>,
): void {
  try {
    const target = storage ?? localStorage;
    if (variant === 'workbench') target.setItem(UI_VARIANT_DEVICE_HINT_KEY, 'workbench');
    else target.removeItem(UI_VARIANT_DEVICE_HINT_KEY);
  } catch {
    // Storage can be unavailable in private/locked-down browser contexts.
  }
}
