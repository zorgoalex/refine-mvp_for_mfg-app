import { describe, expect, it } from 'vitest';
import {
  dailyDigestTabVisible,
  digestRuntimeReason,
  formatDigestArea,
  isDigestImageExpired,
  settingsDraftMatchesSaved,
} from './DailyOrderDigestConfig';
import dayjs from 'dayjs';

describe('daily order digest configuration helpers', () => {
  it('shows the digest tab only with the complete permission bundle, independent of the WhatsApp runtime flag', () => {
    const all = ['whatsapp.manage', 'calendar.view', 'orders.view', 'orders.view_financials'];
    expect(dailyDigestTabVisible(all)).toBe(true);
    expect(dailyDigestTabVisible([])).toBe(false);
    expect(dailyDigestTabVisible(undefined)).toBe(false);
    for (const missing of all) {
      expect(dailyDigestTabVisible(all.filter((permission) => permission !== missing))).toBe(false);
    }
  });

  it('formats area consistently and treats missing/expired images as unavailable', () => {
    expect(formatDigestArea(12.5)).toBe('12,50 кв.м.');
    expect(isDigestImageExpired('2026-09-22T10:00:00.000Z', Date.parse('2026-09-22T10:00:00.000Z'))).toBe(true);
    expect(isDigestImageExpired('not-a-date', Date.now())).toBe(true);
    expect(isDigestImageExpired('2026-09-22T10:00:00.000Z', Date.parse('2026-09-22T09:59:59.000Z'))).toBe(false);
  });

  it('explains runtime unavailability without exposing opaque backend text', () => {
    expect(digestRuntimeReason('relay_unavailable')).toContain('недоступен');
    expect(digestRuntimeReason('INTERNAL_SECRET')).not.toContain('INTERNAL_SECRET');
  });

  it('treats hydrated settings as clean even if Ant Design records touched fields', () => {
    const settings = {
      version: 2, enabled: false, groupChatId: '123456789@g.us', sendTime: '08:45', sendWindowMinutes: 30,
      timeZone: 'Asia/Almaty' as const, catchUpPolicy: 'until_deadline' as const,
      catchUpDeadline: '10:00', cardsPerMessage: 2 as const, partialPolicy: 'remaining' as const,
    };
    const draft = {
      ...settings,
      sendTime: dayjs().hour(8).minute(45).second(0).millisecond(0),
      catchUpDeadline: dayjs().hour(10).minute(0).second(0).millisecond(0),
    };
    expect(settingsDraftMatchesSaved(draft, settings)).toBe(true);
    expect(settingsDraftMatchesSaved({ ...draft, enabled: true }, settings)).toBe(false);
    expect(settingsDraftMatchesSaved({ ...draft, cardsPerMessage: 1 }, settings)).toBe(false);
    expect(settingsDraftMatchesSaved({ ...draft, sendWindowMinutes: 0 }, settings)).toBe(false);
  });
});
