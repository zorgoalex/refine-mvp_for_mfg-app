import { useEffect, useState } from 'react';

export function subscribeMediaQuery(
  query: string,
  setMatches: (matches: boolean) => void,
): () => void {
  if (
    typeof globalThis.matchMedia !== 'function'
  ) {
    return () => {};
  }
  const mql = globalThis.matchMedia(query);
  setMatches(mql.matches);
  const onChange = () => {
    setMatches(mql.matches);
  };
  mql.addEventListener('change', onChange);
  return () => {
    mql.removeEventListener('change', onChange);
  };
}

/**
 * Synchronous one-shot check: matches the given media query right now.
 * Used as the initial state of useMediaQuery so the first render
 * already has the correct value (avoids a flash of wrong layout on
 * mobile viewports where useState(false) would otherwise show the
 * desktop layout for one frame before useEffect updates it).
 */
function readMediaQuerySync(query: string): boolean | null {
  if (typeof globalThis.matchMedia !== 'function') {
    return null;
  }
  return globalThis.matchMedia(query).matches;
}

export function useMediaQuery(query: string, ssrDefault = false): boolean {
  // Synchronous matchMedia check on first render so the initial
  // value is correct on the client (avoids a desktop-layout flash
  // on mobile viewports that would otherwise default to ssrDefault
  // until useEffect fires).
  const [matches, setMatches] = useState<boolean>(() => {
    const sync = readMediaQuerySync(query);
    return sync ?? ssrDefault;
  });
  useEffect(() => {
    return subscribeMediaQuery(query, setMatches);
  }, [query]);
  return matches;
}
