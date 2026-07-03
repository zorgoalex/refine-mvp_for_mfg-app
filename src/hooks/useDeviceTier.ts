import { useMediaQuery } from './useMediaQuery';

export type DeviceTier = 'phone' | 'tablet' | 'desktop';

export const PHONE_MEDIA_QUERY = '(max-width: 767px)';
export const TABLET_MEDIA_QUERY = '(min-width: 768px) and (max-width: 1199px)';
export const COARSE_POINTER_QUERY = '(pointer: coarse)';

export function tierFromMatches(phone: boolean, tablet: boolean): DeviceTier {
  if (phone) return 'phone';
  if (tablet) return 'tablet';
  return 'desktop';
}

export function useDeviceTier(): DeviceTier {
  const phone = useMediaQuery(PHONE_MEDIA_QUERY);
  const tablet = useMediaQuery(TABLET_MEDIA_QUERY);
  return tierFromMatches(phone, tablet);
}

export function useIsMobile(): boolean {
  return useDeviceTier() === 'phone';
}

export function useCoarsePointer(): boolean {
  return useMediaQuery(COARSE_POINTER_QUERY);
}
