export function buildNotificationDeliveryKey(input: { outboxEventId: string; ruleId: string; userId: number }): string {
  return `notif-rule:${input.outboxEventId}:${input.ruleId}:${input.userId}`;
}
