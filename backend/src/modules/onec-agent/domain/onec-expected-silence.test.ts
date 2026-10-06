import { describe, expect, it } from 'vitest';
import { expectedSilenceProblem, isSilenceExpected, parseExpectedSilence } from './onec-expected-silence';

const at = (iso: string) => new Date(iso);
const THREE_MIN = 180_000;

describe('expected daily silence of a 1C agent', () => {
  it('parses HH:MM-HH:MM in UTC, also across midnight, and refuses empty, long or malformed intervals', () => {
    expect(parseExpectedSilence('23:45-00:25')).toEqual({ startMinute: 1425, endMinute: 25, lengthMinutes: 40 });
    expect(parseExpectedSilence('02:00-02:30')).toEqual({ startMinute: 120, endMinute: 150, lengthMinutes: 30 });
    for (const bad of [null, undefined, '', '23:45', '23:45-23:45', '24:00-00:10', '23:60-00:10', '1:00-2:00', '00:00-02:01', '22:00-01:00', '23:45 - 00:25']) {
      expect(parseExpectedSilence(bad as string | null), String(bad)).toBeNull();
    }
    expect(parseExpectedSilence('00:00-02:00')).not.toBeNull();
    expect(expectedSilenceProblem('23:45-00:25')).toBeNull();
    expect(expectedSilenceProblem('2345-0025')).toMatch(/Формат/);
    expect(expectedSilenceProblem('20:00-23:00')).toMatch(/длиннее 120 минут/);
    expect(expectedSilenceProblem('10:00-10:00')).toMatch(/пустым/);
  });

  it('explains a silence that began at or after the interval start (clean stop at 23:50, back after 00:00)', () => {
    const interval = parseExpectedSilence('23:45-00:25');
    const lastHeartbeat = at('2026-10-05T23:49:33Z');
    for (const now of ['2026-10-05T23:53:16Z', '2026-10-05T23:59:59Z', '2026-10-06T00:00:00Z', '2026-10-06T00:24:59Z']) {
      expect(isSilenceExpected(interval, at(now), lastHeartbeat, THREE_MIN), now).toBe(true);
    }
    // A heartbeat shortly before the interval (within the alert threshold) is still the same planned stop.
    expect(isSilenceExpected(interval, at('2026-10-05T23:46:00Z'), at('2026-10-05T23:42:30Z'), THREE_MIN)).toBe(true);
  });

  it('does not explain a silence outside the interval, one that outlasts it, or one that began long before it', () => {
    const interval = parseExpectedSilence('23:45-00:25');
    // Still silent when the interval ends: reported from 00:25:00 on.
    expect(isSilenceExpected(interval, at('2026-10-06T00:25:00Z'), at('2026-10-05T23:49:33Z'), THREE_MIN)).toBe(false);
    expect(isSilenceExpected(interval, at('2026-10-06T01:10:00Z'), at('2026-10-05T23:49:33Z'), THREE_MIN)).toBe(false);
    // A power cut at 16:44 has nothing to do with the night interval.
    expect(isSilenceExpected(interval, at('2026-10-06T16:48:19Z'), at('2026-10-06T16:44:31Z'), THREE_MIN)).toBe(false);
    // The agent died at 20:03 and is still down at 23:50: the interval must not hide it.
    expect(isSilenceExpected(interval, at('2026-10-05T23:50:00Z'), at('2026-10-05T20:03:23Z'), THREE_MIN)).toBe(false);
    // Yesterday's stop, the agent never came back: today's interval does not explain a 24-hour silence.
    expect(isSilenceExpected(interval, at('2026-10-06T23:50:00Z'), at('2026-10-05T23:49:33Z'), THREE_MIN)).toBe(false);
    // No interval, or an agent that never reported.
    expect(isSilenceExpected(null, at('2026-10-05T23:53:16Z'), at('2026-10-05T23:49:33Z'), THREE_MIN)).toBe(false);
    expect(isSilenceExpected(interval, at('2026-10-05T23:53:16Z'), null, THREE_MIN)).toBe(false);
  });

  it('works for an interval that does not cross midnight', () => {
    const interval = parseExpectedSilence('02:00-02:30');
    expect(isSilenceExpected(interval, at('2026-10-06T02:10:00Z'), at('2026-10-06T02:01:00Z'), THREE_MIN)).toBe(true);
    expect(isSilenceExpected(interval, at('2026-10-06T02:30:00Z'), at('2026-10-06T02:01:00Z'), THREE_MIN)).toBe(false);
    expect(isSilenceExpected(interval, at('2026-10-06T01:59:59Z'), at('2026-10-06T01:50:00Z'), THREE_MIN)).toBe(false);
  });
});
