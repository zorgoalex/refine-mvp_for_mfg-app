import { useMediaQuery } from './useMediaQuery';
import { getStoredTabletMode } from '../theme/themeStorage';
import { authStorage } from '../utils/auth';

export type DeviceTier = 'phone' | 'tablet' | 'tablet-landscape' | 'desktop';

export const PHONE_MEDIA_QUERY = '(max-width: 767px)';
export const PHONE_LANDSCAPE_MEDIA_QUERY = '(pointer: coarse) and (max-height: 599px) and (max-width: 999px), (any-pointer: coarse) and (max-height: 599px) and (max-width: 999px)';
export const SHORT_TABLET_LANDSCAPE_VIEWPORT_QUERY = '(min-width: 1000px) and (max-width: 1399px) and (max-height: 599px) and (orientation: landscape)';
export const TABLET_MEDIA_QUERY = [
  '(pointer: coarse) and (min-width: 768px) and (max-width: 899px) and (min-height: 600px)',
  '(any-pointer: coarse) and (min-width: 768px) and (max-width: 899px) and (min-height: 600px)',
  '(pointer: coarse) and (min-width: 900px) and (max-width: 1399px) and (min-height: 600px) and (orientation: portrait)',
  '(any-pointer: coarse) and (min-width: 900px) and (max-width: 1399px) and (min-height: 600px) and (orientation: portrait)',
].join(', ');
export const TABLET_LANDSCAPE_MEDIA_QUERY = [
  '(pointer: coarse) and (min-width: 900px) and (max-width: 1399px) and (min-height: 600px) and (orientation: landscape)',
  '(any-pointer: coarse) and (min-width: 900px) and (max-width: 1399px) and (min-height: 600px) and (orientation: landscape)',
  `(pointer: coarse) and ${SHORT_TABLET_LANDSCAPE_VIEWPORT_QUERY}`,
  `(any-pointer: coarse) and ${SHORT_TABLET_LANDSCAPE_VIEWPORT_QUERY}`,
].join(', ');
export const COARSE_POINTER_QUERY = '(pointer: coarse), (any-pointer: coarse)';
export const LANDSCAPE_MEDIA_QUERY = '(orientation: landscape)';

export function tierFromMatches(
  phone: boolean,
  phoneLandscape: boolean,
  tabletLandscape: boolean,
  tablet: boolean,
  forceTablet = false,
  landscape = tabletLandscape,
): DeviceTier {
  if (forceTablet) return landscape ? 'tablet-landscape' : 'tablet';
  if (phone) return 'phone';
  if (phoneLandscape) return 'phone';
  if (tabletLandscape) return 'tablet-landscape';
  if (tablet) return 'tablet';
  return 'desktop';
}

export function useDeviceTier(): DeviceTier {
  const phone = useMediaQuery(PHONE_MEDIA_QUERY);
  const phoneLandscape = useMediaQuery(PHONE_LANDSCAPE_MEDIA_QUERY);
  const tabletLandscape = useMediaQuery(TABLET_LANDSCAPE_MEDIA_QUERY);
  const tablet = useMediaQuery(TABLET_MEDIA_QUERY);
  const landscape = useMediaQuery(LANDSCAPE_MEDIA_QUERY);
  return tierFromMatches(
    phone,
    phoneLandscape,
    tabletLandscape,
    tablet,
    isTabletModeForced(),
    landscape,
  );
}

export function useIsMobile(): boolean {
  return useDeviceTier() === 'phone';
}

export function useCoarsePointer(): boolean {
  return useMediaQuery(COARSE_POINTER_QUERY);
}

export function isTabletTier(tier: DeviceTier): boolean {
  return tier === 'tablet' || tier === 'tablet-landscape';
}

export function readDeviceTier(
  matchMediaRef: typeof globalThis.matchMedia | undefined = globalThis.matchMedia,
  forceTablet = isTabletModeForced(),
): DeviceTier {
  if (typeof matchMediaRef !== 'function') return 'desktop';
  return tierFromMatches(
    matchMediaRef(PHONE_MEDIA_QUERY).matches,
    matchMediaRef(PHONE_LANDSCAPE_MEDIA_QUERY).matches,
    matchMediaRef(TABLET_LANDSCAPE_MEDIA_QUERY).matches,
    matchMediaRef(TABLET_MEDIA_QUERY).matches,
    forceTablet,
    matchMediaRef(LANDSCAPE_MEDIA_QUERY).matches,
  );
}

export function isTabletDevice(): boolean {
  return isTabletTier(readDeviceTier());
}

export function isTabletModeForced(): boolean {
  if (typeof localStorage === 'undefined') return false;
  const id = authStorage.getUser()?.id;
  if (id === undefined || id === null) return false;
  return getStoredTabletMode(String(id)) === true;
}
