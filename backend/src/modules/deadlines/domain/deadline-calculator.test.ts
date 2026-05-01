import { describe, expect, it } from 'vitest';
import { calculateDeadlineTiming, calculateDelayMinutes } from './deadline-calculator';

describe('deadline calculator', () => {
  it('returns remaining minutes and warning severity for upcoming deadlines', () => {
    expect(
      calculateDeadlineTiming({
        deadlineAt: '2026-05-02T10:00:00.000Z',
        now: '2026-05-01T10:00:00.000Z',
        status: 'active',
      }),
    ).toEqual({
      remainingMinutes: 1440,
      delayMinutes: null,
      severity: 'warning',
    });
  });

  it('returns delay minutes and critical severity for expired deadlines', () => {
    expect(
      calculateDeadlineTiming({
        deadlineAt: '2026-05-01T09:00:00.000Z',
        now: '2026-05-01T10:30:00.000Z',
        status: 'active',
      }),
    ).toEqual({
      remainingMinutes: null,
      delayMinutes: 90,
      severity: 'critical',
    });
    expect(
      calculateDelayMinutes({
        deadlineAt: '2026-05-01T09:00:00.000Z',
        occurredAt: '2026-05-01T10:30:00.000Z',
      }),
    ).toBe(90);
  });
});
