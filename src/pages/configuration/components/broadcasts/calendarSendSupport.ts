import { useEffect, useState } from 'react';
import { ApiError } from '../../../../api/apiError';
import { authSession } from '../../../../api/authSession';
import { broadcastsApi } from '../../../../api/broadcastsApi';
import type { CalendarSendEnvelope } from '../../../../api/broadcastsApiTypes';
import type { PermissionName } from '../../../../api/types/authApi.types';
import { canAll } from '../../../../utils/permissions';

export const CALENDAR_SEND_REQUIRED_PERMISSIONS: readonly PermissionName[] = [
  'whatsapp.manage',
  'calendar.view',
  'orders.view',
  'orders.view_financials',
];

/**
 * `denied`: the user lacks a permission (no probe is made). `supported` / `unsupported`: the
 * backend answered 200 / 404 and the answer is cached for the session. `unknown`: any other
 * failure — treated as hidden and probed again by the next consumer.
 */
export type CalendarSendSupport = 'checking' | 'denied' | 'supported' | 'unsupported' | 'unknown';

export function hasCalendarSendPermissions(user = authSession.getUser()): boolean {
  return canAll(CALENDAR_SEND_REQUIRED_PERMISSIONS, user);
}

/** Only a definite 404 means «old backend»; everything else is a transient unknown. */
export function classifyProbeError(error: unknown): 'unsupported' | 'unknown' {
  return error instanceof ApiError && error.status === 404 ? 'unsupported' : 'unknown';
}

interface CachedProbe {
  scope: string;
  support: 'supported' | 'unsupported';
  minIntervalMinutes: number | null;
}

let cache: CachedProbe | null = null;
let inflight: { scope: string; promise: Promise<CachedProbe | null> } | null = null;

export function resetCalendarSendSupportCache(): void {
  cache = null;
  inflight = null;
}

function currentScope(): string {
  return String(authSession.getUser()?.id ?? '');
}

export function getCachedCalendarSendSupport(): { support: 'supported' | 'unsupported'; minIntervalMinutes: number | null } | null {
  return cache && cache.scope === currentScope() ? cache : null;
}

/** Keeps the cached interval (used in the cooldown toast) current after a settings save. */
export function noteCalendarSendInterval(minIntervalMinutes: number): void {
  if (cache && cache.scope === currentScope()) cache = { ...cache, minIntervalMinutes };
}

export async function probeCalendarSendSupport(
  fetcher: () => Promise<CalendarSendEnvelope> = broadcastsApi.calendarSendSettings,
): Promise<CachedProbe | null> {
  const scope = currentScope();
  if (cache?.scope === scope) return cache;
  if (inflight?.scope === scope) return inflight.promise;
  const promise = fetcher().then<CachedProbe | null, CachedProbe | null>(
    (envelope) => {
      const result: CachedProbe = { scope, support: 'supported', minIntervalMinutes: envelope.settings.minIntervalMinutes };
      if (currentScope() === scope) cache = result;
      return result;
    },
    (error) => {
      if (classifyProbeError(error) !== 'unsupported') return null;
      const result: CachedProbe = { scope, support: 'unsupported', minIntervalMinutes: null };
      if (currentScope() === scope) cache = result;
      return result;
    },
  ).finally(() => { if (inflight?.promise === promise) inflight = null; });
  inflight = { scope, promise };
  return promise;
}

export function initialSupport(allowed: boolean): CalendarSendSupport {
  if (!allowed) return 'denied';
  return getCachedCalendarSendSupport()?.support ?? 'checking';
}

export function useCalendarSendSupport(): { support: CalendarSendSupport; minIntervalMinutes: number | null } {
  const user = authSession.getUser();
  const allowed = hasCalendarSendPermissions(user);
  const scope = String(user?.id ?? '');
  const [support, setSupport] = useState<CalendarSendSupport>(() => initialSupport(allowed));

  useEffect(() => {
    if (!allowed) { setSupport('denied'); return undefined; }
    const cached = getCachedCalendarSendSupport();
    if (cached) { setSupport(cached.support); return undefined; }
    let active = true;
    setSupport('checking');
    void probeCalendarSendSupport().then((result) => { if (active) setSupport(result?.support ?? 'unknown'); });
    return () => { active = false; };
  }, [allowed, scope]);

  return { support, minIntervalMinutes: getCachedCalendarSendSupport()?.minIntervalMinutes ?? null };
}
