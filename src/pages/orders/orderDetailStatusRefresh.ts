export function mergeOrderDetailStatusFreshness(
  lastSuccessfulAt: number,
  baselineUpdatedAt: number,
): number {
  const last = normalizeTimestamp(lastSuccessfulAt);
  const baseline = normalizeTimestamp(baselineUpdatedAt);
  return Math.max(last, baseline);
}

export function isOrderDetailStatusRefreshDue(
  lastSuccessfulAt: number,
  staleAfterMs: number,
  now = Date.now(),
): boolean {
  const last = normalizeTimestamp(lastSuccessfulAt);
  if (last === 0) return true;
  return now - last >= Math.max(1_000, staleAfterMs);
}

function normalizeTimestamp(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}
