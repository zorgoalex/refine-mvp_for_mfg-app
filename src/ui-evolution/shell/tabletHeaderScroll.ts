export interface TabletScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  horizontalOnly?: boolean;
}

export const TABLET_HEADER_COLLAPSE_AT = 32;
export const TABLET_HEADER_EXPAND_AT = 8;

export function nextTabletHeaderCompactState(
  current: boolean,
  metrics: TabletScrollMetrics,
): boolean {
  if (metrics.horizontalOnly || metrics.scrollHeight <= metrics.clientHeight + 2) {
    return current;
  }
  if (metrics.scrollTop >= TABLET_HEADER_COLLAPSE_AT) return true;
  if (metrics.scrollTop <= TABLET_HEADER_EXPAND_AT) return false;
  return current;
}
