import { useEffect, useState } from 'react';
import { backendApiPath } from '../api/apiRoutes';
import { httpClient } from '../api/httpClient';

const TTL_MS = 5 * 60 * 1000;
let cached: { value: boolean; at: number } | null = null;
let inFlight: Promise<boolean> | null = null;

/**
 * Whether the backend knows Bazis project cards (GET /api/v1/health/capabilities, migration 279). An open tab of this
 * frontend after a backend rollback gets `false` (404 on an older backend) and hides what the backend lacks; checked
 * at load and every 5 minutes. Unknown yet — `true` (the commands still answer «обновите страницу» on a mismatch).
 */
export function useBazisCardsCapability(): boolean {
  const [value, setValue] = useState<boolean>(cached?.value ?? true);
  useEffect(() => {
    let alive = true;
    const check = () => {
      if (cached && Date.now() - cached.at < TTL_MS) {
        setValue(cached.value);
        return;
      }
      inFlight ??= httpClient
        .get<{ bazisProjectCards?: boolean }>(backendApiPath('/health/capabilities'))
        .then((body) => body?.bazisProjectCards === true)
        // Only a missing route (an older backend) says «no»; a network error keeps what was known (R4 #1).
        .catch((error: { status?: number }) => (error?.status === 404 ? false : cached?.value ?? true))
        .then((result) => {
          cached = { value: result, at: Date.now() };
          inFlight = null;
          return result;
        });
      void inFlight.then((result) => {
        if (alive) setValue(result);
      });
    };
    check();
    const timer = setInterval(check, TTL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);
  return value;
}
