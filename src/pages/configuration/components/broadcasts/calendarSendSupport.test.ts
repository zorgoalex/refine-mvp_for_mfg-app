import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../../api/apiError';
import {
  CALENDAR_SEND_REQUIRED_PERMISSIONS,
  classifyProbeError,
  getCachedCalendarSendSupport,
  hasCalendarSendPermissions,
  hasCalendarSendSettingsPermissions,
  initialSupport,
  noteCalendarSendInterval,
  probeCalendarSendSupport,
  resetCalendarSendSupportCache,
} from './calendarSendSupport';

const apiError = (status: number) => new ApiError({ code: `HTTP_${status}`, message: 'x', status });

describe('calendar send support probe', () => {
  beforeEach(() => resetCalendarSendSupportCache());

  it('classifies only 404 as unsupported', () => {
    expect(classifyProbeError(apiError(404))).toBe('unsupported');
    expect(classifyProbeError(apiError(500))).toBe('unknown');
    expect(classifyProbeError(apiError(403))).toBe('unknown');
    expect(classifyProbeError(new TypeError('network'))).toBe('unknown');
  });

  it('caches supported and unsupported answers for the session', async () => {
    const ok = vi.fn(async () => 15);
    expect((await probeCalendarSendSupport(ok))?.support).toBe('supported');
    expect((await probeCalendarSendSupport(ok))?.support).toBe('supported');
    expect(ok).toHaveBeenCalledTimes(1);
    expect(getCachedCalendarSendSupport()).toMatchObject({ support: 'supported', minIntervalMinutes: 15 });
    noteCalendarSendInterval(40);
    expect(getCachedCalendarSendSupport()?.minIntervalMinutes).toBe(40);

    resetCalendarSendSupportCache();
    const missing = vi.fn(async () => { throw apiError(404); });
    expect((await probeCalendarSendSupport(missing))?.support).toBe('unsupported');
    await probeCalendarSendSupport(missing);
    expect(missing).toHaveBeenCalledTimes(1);
  });

  it('does not cache unknown failures, so the next consumer probes again', async () => {
    const failing = vi.fn(async () => { throw apiError(500); });
    expect(await probeCalendarSendSupport(failing)).toBeNull();
    expect(getCachedCalendarSendSupport()).toBeNull();
    const ok = vi.fn(async () => 15);
    expect((await probeCalendarSendSupport(ok))?.support).toBe('supported');
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight request between concurrent consumers', async () => {
    const ok = vi.fn(async () => 15);
    await Promise.all([probeCalendarSendSupport(ok), probeCalendarSendSupport(ok)]);
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it('is denied without probing when a permission is missing', () => {
    expect(initialSupport(false)).toBe('denied');
    expect(initialSupport(true)).toBe('checking');
    const all = { orders: { view: 'all' } };
    const user = (permissions: string[], policyScopes: unknown = all, policyScopeSets?: unknown) => ({ permissions, policyScopes, policyScopeSets }) as never;
    const bundle = [...CALENDAR_SEND_REQUIRED_PERMISSIONS];
    expect(hasCalendarSendPermissions(user(bundle))).toBe(true);
    expect(hasCalendarSendPermissions(user(['whatsapp.calendar_send', 'calendar.view', 'orders.view']))).toBe(false);
    // The settings permission alone no longer shows the button, and the button does not need it.
    expect(hasCalendarSendPermissions(user(['whatsapp.manage', 'calendar.view', 'orders.view', 'orders.view_financials']))).toBe(false);
    // The send takes every order of the day: a user limited to own or assigned orders has no button.
    expect(hasCalendarSendPermissions(user(bundle, { orders: { view: 'own' } }))).toBe(false);
    expect(hasCalendarSendPermissions(user(bundle, { orders: { view: 'none' } }))).toBe(false);
    expect(hasCalendarSendPermissions(user(bundle, all, { orders: { view: ['own', 'assigned'] } }))).toBe(false);
    expect(hasCalendarSendPermissions(user(bundle, { orders: { view: 'own' } }, { orders: { view: ['own', 'all'] } }))).toBe(true);
    expect(hasCalendarSendPermissions(null)).toBe(false);
  });

  it('keeps the settings form apart from the send: its own permissions, its own probe and cache', async () => {
    const user = (permissions: string[], view: string) => ({ permissions, policyScopes: { orders: { view } } }) as never;
    const settingsOnly = user(['whatsapp.manage', 'calendar.view', 'orders.view', 'orders.view_financials'], 'own');
    // May configure without the calendar send permission and with a limited order scope; may not send.
    expect(hasCalendarSendSettingsPermissions(settingsOnly)).toBe(true);
    expect(hasCalendarSendPermissions(settingsOnly)).toBe(false);
    const sendOnly = user([...CALENDAR_SEND_REQUIRED_PERMISSIONS], 'all');
    expect(hasCalendarSendSettingsPermissions(sendOnly)).toBe(false);
    expect(hasCalendarSendPermissions(sendOnly)).toBe(true);

    // Previous backend: the availability read is 404 (no button), the settings read still answers (form stays).
    const missing = vi.fn(async () => { throw apiError(404); });
    const settings = vi.fn(async () => 20);
    expect((await probeCalendarSendSupport(missing, 'send'))?.support).toBe('unsupported');
    expect((await probeCalendarSendSupport(settings, 'settings'))?.support).toBe('supported');
    expect(getCachedCalendarSendSupport('send')).toMatchObject({ support: 'unsupported' });
    expect(getCachedCalendarSendSupport('settings')).toMatchObject({ support: 'supported', minIntervalMinutes: 20 });
    expect(initialSupport(true, 'settings')).toBe('supported');
    expect(initialSupport(false, 'settings')).toBe('denied');
  });
});
