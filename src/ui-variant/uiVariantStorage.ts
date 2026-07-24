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
