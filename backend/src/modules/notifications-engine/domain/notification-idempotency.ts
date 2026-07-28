import type { NotificationChannel } from './notification-rule.types';

export function buildNotificationDeliveryKey(input: {
  outboxEventId: string;
  ruleId: string;
  userId: number;
  channel?: NotificationChannel;
}): string {
  const base = `notif-rule:${input.outboxEventId}:${input.ruleId}:${input.userId}`;
  return input.channel && input.channel !== 'in_app' ? `${base}:${input.channel}` : base;
}
