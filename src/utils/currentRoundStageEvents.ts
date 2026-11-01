/**
 * «Переделка»: an order's stage marks (production_status_events) are kept per production round; earlier rounds are
 * history. Readers of the marks take only the order's current round — given, or else the newest round among its
 * marks (a round's marks appear as soon as its details are restaged; «Это не переделка» deletes them). A mark
 * without `round_no` (before migration 274) is round 1.
 */
export interface RoundedStageEvent {
  order_id?: number | string | null;
  round_no?: number | string | null;
}

export function currentRoundStageEvents<T extends RoundedStageEvent>(
  events: readonly T[],
  currentRoundByOrder?: ReadonlyMap<number, number> | ((orderId: number) => number | null | undefined),
): T[] {
  const roundOf = (event: T) => Number(event.round_no ?? 1) || 1;
  const newest = new Map<number, number>();
  for (const event of events) {
    if (event.order_id == null) continue;
    const orderId = Number(event.order_id);
    newest.set(orderId, Math.max(newest.get(orderId) ?? 1, roundOf(event)));
  }
  const given = (orderId: number) => {
    const value = typeof currentRoundByOrder === 'function' ? currentRoundByOrder(orderId) : currentRoundByOrder?.get(orderId);
    return value == null || !Number.isFinite(Number(value)) ? null : Number(value);
  };
  return events.filter((event) => {
    if (event.order_id == null) return true;
    const orderId = Number(event.order_id);
    return roundOf(event) === (given(orderId) ?? newest.get(orderId) ?? 1);
  });
}
