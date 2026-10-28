/** Whether the board page may look for the card of a link (`cardKind`/`cardId`) in what it shows now.
 * - `skip`: not this page's to look for — the board is hidden, or the engine's own view is shown (it marks the
 *   focused card itself);
 * - `wait`: what is shown may not hold the card yet — a load is running, or the shown data were read for another
 *   query (the engine snapshot for another focus/period, `today` without this bath as its focus, its orders not in);
 * - `look`: the shown data were read for this very link: a card not found there is not on the board. */
export type MdfDeepLinkLookup = 'skip' | 'wait' | 'look';

export function mdfDeepLinkLookup(input: {
  active: boolean;
  /** the legacy data (`today`) loading */
  loading: boolean;
  /** the order cards of the shown `today` still loading (a card filtered by its order, e.g. planned today) */
  ordersLoading: boolean;
  renderMode: 'loading' | 'unavailable' | 'published' | 'legacy';
  engineViewShown: boolean;
  publishedLoading: boolean;
  publishedSettledForQuery: boolean;
  kind: string;
  cardId: string;
  /** the bath the shown `today` response was read with as its focus */
  todayFocusBathCardId: string | null;
}): MdfDeepLinkLookup {
  if (!input.active || input.renderMode === 'unavailable' || input.engineViewShown) return 'skip';
  if (input.loading || input.ordersLoading || input.renderMode === 'loading') return 'wait';
  if (input.renderMode === 'published' && (input.publishedLoading || !input.publishedSettledForQuery)) return 'wait';
  if (input.kind === 'bath' && input.todayFocusBathCardId !== input.cardId) return 'wait';
  return 'look';
}
