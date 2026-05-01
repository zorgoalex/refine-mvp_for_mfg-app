import { describe, expect, it } from 'vitest';
import { getCompletionDeadlineStatus, isTerminalDeadlineStatus } from './deadline-status';

describe('deadline status domain helpers', () => {
  it('derives completion status from completedAt and deadlineAt', () => {
    expect(
      getCompletionDeadlineStatus({
        completedAt: '2026-05-01T10:00:00.000Z',
        deadlineAt: '2026-05-01T10:00:00.000Z',
      }),
    ).toBe('completed_on_time');
    expect(
      getCompletionDeadlineStatus({
        completedAt: '2026-05-01T10:01:00.000Z',
        deadlineAt: '2026-05-01T10:00:00.000Z',
      }),
    ).toBe('completed_late');
  });

  it('treats expired/completed/cancelled/superseded as terminal statuses', () => {
    expect(isTerminalDeadlineStatus('active')).toBe(false);
    expect(isTerminalDeadlineStatus('paused')).toBe(false);
    expect(isTerminalDeadlineStatus('expired')).toBe(true);
    expect(isTerminalDeadlineStatus('completed_late')).toBe(true);
    expect(isTerminalDeadlineStatus('cancelled')).toBe(true);
    expect(isTerminalDeadlineStatus('superseded')).toBe(true);
  });
});
