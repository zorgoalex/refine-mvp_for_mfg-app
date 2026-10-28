import { CLIENT_SCREEN_PATH } from './clientScreenPath';

/**
 * Opens the customer window, on another monitor when the browser lets the app see the screens
 * (Window Management API, one permission prompt). `noopener` is mandatory: without it the new
 * window would get a copy of this window's sessionStorage, where the order drafts live.
 */
interface ScreenLike { left?: number; top?: number; availLeft?: number; availTop?: number; availWidth: number; availHeight: number; isPrimary?: boolean }

/** Window features for a screen, or for a plain popup when no other screen is known. */
export function clientScreenWindowFeatures(target: ScreenLike | null): string {
  if (!target) return 'popup,noopener,width=1280,height=800';
  const left = Math.round(target.availLeft ?? target.left ?? 0);
  const top = Math.round(target.availTop ?? target.top ?? 0);
  return `popup,noopener,left=${left},top=${top},width=${Math.round(target.availWidth)},height=${Math.round(target.availHeight)}`;
}

/** The screen to show the customer on: any screen other than the one this window is on. */
export function pickCustomerScreen<T extends ScreenLike>(screens: readonly T[], current: T | null | undefined): T | null {
  return screens.find((screen) => screen !== current) ?? null;
}

export async function openClientScreenWindow(): Promise<void> {
  let target: ScreenLike | null = null;
  try {
    const details = await (window as unknown as { getScreenDetails?: () => Promise<{ screens: ScreenLike[]; currentScreen: ScreenLike }> }).getScreenDetails?.();
    if (details) target = pickCustomerScreen(details.screens, details.currentScreen);
  } catch {
    // No permission or no API: a plain popup the manager drags to the second monitor.
  }
  window.open(CLIENT_SCREEN_PATH, 'erp-client-screen', clientScreenWindowFeatures(target));
}
