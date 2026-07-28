import type { DatabaseClient } from '../../../database/database.types';
import type { NotificationChannel, NotificationLevel } from '../domain/notification-rule.types';

export interface EnqueueNotificationChannelDeliveryInput {
  notificationRuleId: string;
  outboxEventId: string;
  userId: number;
  channel: Exclude<NotificationChannel, 'in_app'>;
  level: NotificationLevel;
  title: string;
  message: string;
  entityType: string | null;
  entityId: string | null;
  sourceType: string;
  sourceId: string | null;
  idempotencyKey: string;
}

export interface NotificationChannelDeliveryPort {
  enqueueIfAbsent(
    client: DatabaseClient,
    input: EnqueueNotificationChannelDeliveryInput,
  ): Promise<{ created: boolean; deliveryId: string }>;
}
