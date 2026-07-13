import type { ThemeMode, UiSize } from './themeTypes';

export function themeModeStorageKey(userId: string): string {
  return `erp.themeMode.${userId}`;
}

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'light' || value === 'dark';
}

export function getStoredThemeMode(userId: string): ThemeMode | null {
  if (typeof localStorage === 'undefined') return null;
  const value = localStorage.getItem(themeModeStorageKey(userId));
  return isThemeMode(value) ? value : null;
}

export function setStoredThemeMode(userId: string, mode: ThemeMode): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(themeModeStorageKey(userId), mode);
}

export function uiSizeStorageKey(userId: string): string {
  return `erp.uiSize.${userId}`;
}

export function isUiSize(value: unknown): value is UiSize {
  return value === 'default' || value === 'small';
}

export function getStoredUiSize(userId: string): UiSize | null {
  if (typeof localStorage === 'undefined') return null;
  const value = localStorage.getItem(uiSizeStorageKey(userId));
  return isUiSize(value) ? value : null;
}

export function setStoredUiSize(userId: string, size: UiSize): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(uiSizeStorageKey(userId), size);
}
