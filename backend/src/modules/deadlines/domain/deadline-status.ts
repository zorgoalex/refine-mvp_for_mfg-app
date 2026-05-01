export const DEADLINE_STATUSES = [
  'active',
  'paused',
  'expired',
  'completed_on_time',
  'completed_late',
  'cancelled',
  'superseded',
] as const;

export type DeadlineStatus = (typeof DEADLINE_STATUSES)[number];

const terminalDeadlineStatuses = new Set<DeadlineStatus>([
  'expired',
  'completed_on_time',
  'completed_late',
  'cancelled',
  'superseded',
]);

export function isDeadlineStatus(value: unknown): value is DeadlineStatus {
  return typeof value === 'string' && DEADLINE_STATUSES.includes(value as DeadlineStatus);
}

export function isTerminalDeadlineStatus(status: DeadlineStatus): boolean {
  return terminalDeadlineStatuses.has(status);
}

export function getCompletionDeadlineStatus(input: {
  completedAt: string | Date;
  deadlineAt: string | Date;
}): Extract<DeadlineStatus, 'completed_on_time' | 'completed_late'> {
  return toTime(input.completedAt) <= toTime(input.deadlineAt)
    ? 'completed_on_time'
    : 'completed_late';
}

function toTime(value: string | Date): number {
  const time = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(time)) {
    throw new Error('Invalid deadline date value');
  }

  return time;
}
