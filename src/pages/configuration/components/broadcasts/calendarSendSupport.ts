import { useEffect, useState } from 'react';
import { ApiError } from '../../../../api/apiError';
import { authSession } from '../../../../api/authSession';
import { broadcastsApi } from '../../../../api/broadcastsApi';
import type { PermissionName } from '../../../../api/types/authApi.types';
import { canAll } from '../../../../utils/permissions';

/** The backend gate of the calendar command; the calendar send settings need whatsapp.manage instead. */
export const CALENDAR_SEND_REQUIRED_PERMISSIONS: readonly PermissionName[] = [
  'whatsapp.calendar_send',
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

/**
 * The send takes every order of the day, so the backend also requires the order visibility «all»
 * (scope set of access groups when sent, otherwise the scalar of older backends).
 */
export function hasCalendarSendPermissions(user = authSession.getUser()): boolean {
  if (!canAll(CALENDAR_SEND_REQUIRED_PERMISSIONS, user)) return false;
  const scalar = user?.policyScopes?.orders.view;
  const scopes = user?.policyScopeSets?.orders.view ?? (scalar && scalar !== 'none' ? [scalar] : []);
  return scopes.includes('all');
}

/**
 * The settings form («Конфигурация → Рассылка сообщений») is a separate right from the send: it keeps the
 * settings bundle and does not depend on the calendar send permission or the order visibility scope.
 */
export const CALENDAR_SEND_SETTINGS_PERMISSIONS: readonly PermissionName[] = [
  'whatsapp.manage',
  'calendar.view',
  'orders.view',
  'orders.view_financials',
];

export function hasCalendarSendSettingsPermissions(user = authSession.getUser()): boolean {
  return canAll(CALENDAR_SEND_SETTINGS_PERMISSIONS, user);
}

/** Only a definite 404 means «old backend»; everything else is a transient unknown. */
export function classifyProbeError(error: unknown): 'unsupported' | 'unknown' {
  return error instanceof ApiError && error.status === 404 ? 'unsupported' : 'unknown';
}

/** `send`: the calendar button (availability read). `settings`: the settings form (settings read). */
export type CalendarSendProbeKind = 'send' | 'settings';

interface CachedProbe {
  scope: string;
  support: 'supported' | 'unsupported';
  minIntervalMinutes: number | null;
}

const PROBES: Record<CalendarSendProbeKind, {
  allowed: (user: ReturnType<typeof authSession.getUser>) => boolean;
  fetch: () => Promise<number>;
}> = {
  send: { allowed: hasCalendarSendPermissions, fetch: () => broadcastsApi.calendarSendAvailability().then((answer) => answer.minIntervalMinutes) },
  settings: { allowed: hasCalendarSendSettingsPermissions, fetch: () => broadcastsApi.calendarSendSettings().then((answer) => answer.settings.minIntervalMinutes) },
};

const cache: Partial<Record<CalendarSendProbeKind, CachedProbe>> = {};
const inflight: Partial<Record<CalendarSendProbeKind, { scope: string; promise: Promise<CachedProbe | null> }>> = {};

export function resetCalendarSendSupportCache(): void {
  for (const kind of ['send', 'settings'] as const) { delete cache[kind]; delete inflight[kind]; }
}

function currentScope(): string {
  return String(authSession.getUser()?.id ?? '');
}

export function getCachedCalendarSendSupport(kind: CalendarSendProbeKind = 'send'): { support: 'supported' | 'unsupported'; minIntervalMinutes: number | null } | null {
  const cached = cache[kind];
  return cached && cached.scope === currentScope() ? cached : null;
}

/** Keeps the cached interval (used in the cooldown toast) current after a settings save. */
export function noteCalendarSendInterval(minIntervalMinutes: number): void {
  for (const kind of ['send', 'settings'] as const) {
    const cached = cache[kind];
    if (cached && cached.scope === currentScope()) cache[kind] = { ...cached, minIntervalMinutes };
  }
}

/** `fetcher` resolves to the minimal interval in minutes of a backend that knows the calendar send. */
export async function probeCalendarSendSupport(
  fetcher: () => Promise<number> = PROBES.send.fetch,
  kind: CalendarSendProbeKind = 'send',
): Promise<CachedProbe | null> {
  const scope = currentScope();
  const cached = cache[kind];
  if (cached?.scope === scope) return cached;
  const pending = inflight[kind];
  if (pending?.scope === scope) return pending.promise;
  const promise = fetcher().then<CachedProbe | null, CachedProbe | null>(
    (minIntervalMinutes) => {
      const result: CachedProbe = { scope, support: 'supported', minIntervalMinutes };
      if (currentScope() === scope) cache[kind] = result;
      return result;
    },
    (error) => {
      if (classifyProbeError(error) !== 'unsupported') return null;
      const result: CachedProbe = { scope, support: 'unsupported', minIntervalMinutes: null };
      if (currentScope() === scope) cache[kind] = result;
      return result;
    },
  ).finally(() => { if (inflight[kind]?.promise === promise) delete inflight[kind]; });
  inflight[kind] = { scope, promise };
  return promise;
}

export function initialSupport(allowed: boolean, kind: CalendarSendProbeKind = 'send'): CalendarSendSupport {
  if (!allowed) return 'denied';
  return getCachedCalendarSendSupport(kind)?.support ?? 'checking';
}

/**
 * `send` (default) answers for the calendar button; `settings` for the settings form — each with its own
 * permissions, read and cache, so a user who may only configure keeps the form and one who may only send
 * keeps the button.
 */
export function useCalendarSendSupport(kind: CalendarSendProbeKind = 'send'): { support: CalendarSendSupport; minIntervalMinutes: number | null } {
  const user = authSession.getUser();
  const allowed = PROBES[kind].allowed(user);
  const scope = String(user?.id ?? '');
  const [support, setSupport] = useState<CalendarSendSupport>(() => initialSupport(allowed, kind));

  useEffect(() => {
    if (!allowed) { setSupport('denied'); return undefined; }
    const cached = getCachedCalendarSendSupport(kind);
    if (cached) { setSupport(cached.support); return undefined; }
    let active = true;
    setSupport('checking');
    void probeCalendarSendSupport(PROBES[kind].fetch, kind).then((result) => { if (active) setSupport(result?.support ?? 'unknown'); });
    return () => { active = false; };
  }, [allowed, scope, kind]);

  return { support, minIntervalMinutes: getCachedCalendarSendSupport(kind)?.minIntervalMinutes ?? null };
}
