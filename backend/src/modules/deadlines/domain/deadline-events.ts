export const DEADLINE_EVENT_TYPES = [
  'DEADLINE_CREATED',
  'DEADLINE_UPDATED',
  'DEADLINE_UPCOMING',
  'DEADLINE_EXPIRED',
  'DEADLINE_COMPLETED_ON_TIME',
  'DEADLINE_COMPLETED_LATE',
  'DEADLINE_PAUSED',
  'DEADLINE_RESUMED',
  'DEADLINE_CANCELLED',
  'DEADLINE_ESCALATED',
  'ORDER_FINAL_DEADLINE_EXPIRED',
  'ORDER_STAGE_DEADLINE_EXPIRED',
  'CLIENT_ACTION_DEADLINE_EXPIRED',
] as const;

export type DeadlineEventType = (typeof DEADLINE_EVENT_TYPES)[number];

export type DeadlineEventSeverity = 'info' | 'warning' | 'critical';

export function isDeadlineEventType(value: unknown): value is DeadlineEventType {
  return typeof value === 'string' && DEADLINE_EVENT_TYPES.includes(value as DeadlineEventType);
}
