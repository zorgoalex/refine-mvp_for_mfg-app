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

export function useMediaQuery(query: string, ssrDefault = false): boolean {
  const [matches, setMatches] = useState<boolean>(ssrDefault);
  useEffect(() => {
    return subscribeMediaQuery(query, setMatches);
  }, [query]);
  return matches;
}
