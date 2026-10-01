import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../../api/apiError';
import type { CalendarSendEnvelope } from '../../../../api/broadcastsApiTypes';
import {
  CALENDAR_SEND_REQUIRED_PERMISSIONS,
  classifyProbeError,
  getCachedCalendarSendSupport,
  hasCalendarSendPermissions,
  initialSupport,
  noteCalendarSendInterval,
  probeCalendarSendSupport,
  resetCalendarSendSupportCache,
} from './calendarSendSupport';

const envelope = { settings: { minIntervalMinutes: 15 } } as unknown as CalendarSendEnvelope;
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
    const ok = vi.fn(async () => envelope);
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
    const ok = vi.fn(async () => envelope);
    expect((await probeCalendarSendSupport(ok))?.support).toBe('supported');
    expect(failing).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight request between concurrent consumers', async () => {
    const ok = vi.fn(async () => envelope);
    await Promise.all([probeCalendarSendSupport(ok), probeCalendarSendSupport(ok)]);
    expect(ok).toHaveBeenCalledTimes(1);
  });

  it('is denied without probing when a permission is missing', () => {
    expect(initialSupport(false)).toBe('denied');
    expect(initialSupport(true)).toBe('checking');
    const user = (permissions: string[]) => ({ permissions }) as never;
    expect(hasCalendarSendPermissions(user([...CALENDAR_SEND_REQUIRED_PERMISSIONS]))).toBe(true);
    expect(hasCalendarSendPermissions(user(['whatsapp.manage', 'calendar.view', 'orders.view']))).toBe(false);
    expect(hasCalendarSendPermissions(null)).toBe(false);
  });
});
