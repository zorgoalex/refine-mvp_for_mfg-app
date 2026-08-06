import { useMediaQuery } from './useMediaQuery';

export type DeviceTier = 'phone' | 'tablet' | 'tablet-landscape' | 'desktop';

export const PHONE_MEDIA_QUERY = '(max-width: 767px)';
export const PHONE_LANDSCAPE_MEDIA_QUERY = '(pointer: coarse) and (max-height: 599px) and (max-width: 999px), (any-pointer: coarse) and (max-height: 599px) and (max-width: 999px)';
export const TABLET_MEDIA_QUERY = [
  '(pointer: coarse) and (min-width: 768px) and (max-width: 899px) and (min-height: 600px)',
  '(any-pointer: coarse) and (min-width: 768px) and (max-width: 899px) and (min-height: 600px)',
  '(pointer: coarse) and (min-width: 900px) and (max-width: 1399px) and (min-height: 600px) and (orientation: portrait)',
  '(any-pointer: coarse) and (min-width: 900px) and (max-width: 1399px) and (min-height: 600px) and (orientation: portrait)',
].join(', ');
export const TABLET_LANDSCAPE_MEDIA_QUERY = [
  '(pointer: coarse) and (min-width: 900px) and (max-width: 1399px) and (min-height: 600px) and (orientation: landscape)',
  '(any-pointer: coarse) and (min-width: 900px) and (max-width: 1399px) and (min-height: 600px) and (orientation: landscape)',
].join(', ');
export const COARSE_POINTER_QUERY = '(pointer: coarse), (any-pointer: coarse)';

export function tierFromMatches(
  phone: boolean,
  phoneLandscape: boolean,
  tabletLandscape: boolean,
  tablet: boolean,
): DeviceTier {
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
  return tierFromMatches(phone, phoneLandscape, tabletLandscape, tablet);
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
): DeviceTier {
  if (typeof matchMediaRef !== 'function') return 'desktop';
  return tierFromMatches(
    matchMediaRef(PHONE_MEDIA_QUERY).matches,
    matchMediaRef(PHONE_LANDSCAPE_MEDIA_QUERY).matches,
    matchMediaRef(TABLET_LANDSCAPE_MEDIA_QUERY).matches,
    matchMediaRef(TABLET_MEDIA_QUERY).matches,
  );
}

export function isTabletDevice(): boolean {
  return isTabletTier(readDeviceTier());
}
