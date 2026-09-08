import { useCallback, useEffect, useRef, useState } from 'react';

/** Retire URLs only after consumers have committed their replacement src. */
export function useOwnedObjectUrlState<T extends { url: string }>() {
  const [value, setValue] = useState<T | null>(null);
  const owned = useRef(new Set<string>());
  const mounted = useRef(true);
  const replace = useCallback((next: T | null) => {
    if (!mounted.current) {
      if (next) URL.revokeObjectURL(next.url);
      return;
    }
    if (next) owned.current.add(next.url);
    setValue(next);
  }, []);

  useEffect(() => {
    for (const url of owned.current) {
      if (url !== value?.url) {
        URL.revokeObjectURL(url);
        owned.current.delete(url);
      }
    }
  }, [value]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const url of owned.current) URL.revokeObjectURL(url);
      owned.current.clear();
    };
  }, []);

  return [value, replace] as const;
}
