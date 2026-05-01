import type { DeadlineStatus } from './deadline-status';

export type DeadlineSummarySeverity = 'info' | 'warning' | 'critical';

export interface DeadlineTimingSummary {
  remainingMinutes: number | null;
  delayMinutes: number | null;
  severity: DeadlineSummarySeverity;
}

export function calculateDeadlineTiming(input: {
  deadlineAt: string | Date;
  status: DeadlineStatus;
  now?: string | Date;
}): DeadlineTimingSummary {
  const deadlineAt = toTime(input.deadlineAt);
  const now = toTime(input.now ?? new Date());
  const diffMinutes = Math.trunc((deadlineAt - now) / 60000);

  if (input.status === 'expired' || diffMinutes < 0) {
    return {
      remainingMinutes: null,
      delayMinutes: Math.abs(diffMinutes),
      severity: 'critical',
    };
  }

  if (input.status === 'completed_late') {
    return {
      remainingMinutes: null,
      delayMinutes: null,
      severity: 'warning',
    };
  }

  if (input.status === 'completed_on_time' || input.status === 'cancelled') {
    return {
      remainingMinutes: null,
      delayMinutes: null,
      severity: 'info',
    };
  }

  return {
    remainingMinutes: diffMinutes,
    delayMinutes: null,
    severity: diffMinutes <= 24 * 60 ? 'warning' : 'info',
  };
}

export function calculateDelayMinutes(input: {
  deadlineAt: string | Date;
  occurredAt: string | Date;
}): number {
  return Math.max(0, Math.trunc((toTime(input.occurredAt) - toTime(input.deadlineAt)) / 60000));
}

function toTime(value: string | Date): number {
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(time)) {
    throw new Error('Invalid deadline date value');
  }

  return time;
}
