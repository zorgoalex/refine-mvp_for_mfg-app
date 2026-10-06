/**
 * Expected daily silence of an agent: an interval of UTC time in which the agent is known to be off (for example a
 * clean stop before a nightly reboot of the 1C computer). The monitor does not raise «agent silent» for a silence
 * that this interval explains; a silence that began earlier, or that still lasts when the interval ends, is reported.
 *
 * Stored as text "HH:MM-HH:MM" (UTC, may wrap midnight, start ≠ end, at most MAX_MINUTES long); null = not set.
 */
export const EXPECTED_SILENCE_PATTERN = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;
/** A longer interval would hide real outages for too much of the day. */
export const EXPECTED_SILENCE_MAX_MINUTES = 120;

export interface DailyUtcInterval {
  startMinute: number;
  endMinute: number;
  lengthMinutes: number;
}

export function parseExpectedSilence(value: string | null | undefined): DailyUtcInterval | null {
  if (!value || !EXPECTED_SILENCE_PATTERN.test(value)) return null;
  const [start, end] = value.split('-').map((part) => {
    const [hours, minutes] = part.split(':').map(Number);
    return hours! * 60 + minutes!;
  }) as [number, number];
  const lengthMinutes = (end - start + 1440) % 1440;
  if (lengthMinutes === 0 || lengthMinutes > EXPECTED_SILENCE_MAX_MINUTES) return null;
  return { startMinute: start, endMinute: end, lengthMinutes };
}

/** Validation message for the admin API (null = valid; an empty value clears the setting). */
export function expectedSilenceProblem(value: string): string | null {
  if (!EXPECTED_SILENCE_PATTERN.test(value)) return 'Формат: ЧЧ:ММ-ЧЧ:ММ по UTC, например 23:45-00:25';
  if (!parseExpectedSilence(value)) return `Интервал не может быть пустым или длиннее ${EXPECTED_SILENCE_MAX_MINUTES} минут`;
  return null;
}

/** Start of the occurrence of the interval that contains `at`, or null when `at` is outside the interval. */
function occurrenceStart(interval: DailyUtcInterval, at: Date): Date | null {
  const minuteOfDay = at.getUTCHours() * 60 + at.getUTCMinutes();
  const sinceStart = (minuteOfDay - interval.startMinute + 1440) % 1440;
  if (sinceStart >= interval.lengthMinutes) return null;
  const start = new Date(at.getTime());
  start.setUTCSeconds(0, 0);
  start.setUTCMinutes(start.getUTCMinutes() - sinceStart);
  return start;
}

/**
 * True when the current silence is explained by the interval: `now` is inside it and the last heartbeat is not
 * older than the alert threshold before the interval began (i.e. the agent was still alive when the interval
 * started, or stopped during it). An agent that never sent a heartbeat is never «expected silent».
 */
export function isSilenceExpected(
  interval: DailyUtcInterval | null,
  now: Date,
  lastHeartbeatAt: Date | null,
  silentAfterMs: number,
): boolean {
  if (!interval || !lastHeartbeatAt) return false;
  const start = occurrenceStart(interval, now);
  if (!start) return false;
  return lastHeartbeatAt.getTime() >= start.getTime() - silentAfterMs;
}
