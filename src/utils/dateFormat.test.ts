import { describe, expect, it } from 'vitest';

import {
  DISPLAY_DATE_FORMAT,
  DISPLAY_DATE_TIME_FORMAT,
  DISPLAY_DATE_TIME_SECONDS_FORMAT,
  formatDate,
  formatDateTime,
  formatDateTimeFull,
} from './dateFormat';

describe('dateFormat', () => {
  it('uses the shared Russian display date formats', () => {
    expect(DISPLAY_DATE_FORMAT).toBe('DD.MM.YYYY');
    expect(DISPLAY_DATE_TIME_FORMAT).toBe('DD.MM.YYYY HH:mm');
    expect(DISPLAY_DATE_TIME_SECONDS_FORMAT).toBe('DD.MM.YYYY HH:mm:ss');
  });

  it('formats display dates through the shared application format', () => {
    expect(formatDate('2026-06-19')).toBe('19.06.2026');
    expect(formatDateTime('2026-06-19T14:05:00.000Z')).toBe('19.06.2026 14:05');
    expect(formatDateTimeFull('2026-06-19T14:05:06.000Z')).toBe('19.06.2026 14:05:06');
  });
});
