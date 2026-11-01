// A link to another card (client, project) remembers where it was opened from; that card's back arrow returns
// there — to the same screen and tab — rather than one step back in the browser history.
import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

export interface BackOrigin {
  /** path + query of the screen the card was opened from */
  from: string;
  /** e.g. «Заказ 3087» — said on the back arrow */
  fromLabel?: string;
}

export function originState(location: { pathname: string; search?: string }, fromLabel?: string): BackOrigin {
  return { from: `${location.pathname}${location.search ?? ''}`, ...(fromLabel ? { fromLabel } : {}) };
}

export function readBackOrigin(state: unknown): BackOrigin | null {
  if (!state || typeof state !== 'object') return null;
  const { from, fromLabel } = state as { from?: unknown; fromLabel?: unknown };
  if (typeof from !== 'string' || !from.startsWith('/')) return null;
  return { from, ...(typeof fromLabel === 'string' && fromLabel ? { fromLabel } : {}) };
}

/** The screen this card was opened from (or null), and a back action: to it, else one step back. */
export function useBackToOrigin(): { origin: BackOrigin | null; goBack: () => void } {
  const location = useLocation();
  const navigate = useNavigate();
  const origin = readBackOrigin(location.state);
  const goBack = useCallback(() => {
    if (origin) navigate(origin.from);
    else navigate(-1);
  }, [navigate, origin?.from]); // eslint-disable-line react-hooks/exhaustive-deps
  return { origin, goBack };
}

/** A link to a card that remembers this screen as its way back. */
export function useOpenWithOrigin(fromLabel?: string): (to: string) => void {
  const location = useLocation();
  const navigate = useNavigate();
  return useCallback(
    (to: string) => navigate(to, { state: originState(location, fromLabel) }),
    [fromLabel, location, navigate],
  );
}
