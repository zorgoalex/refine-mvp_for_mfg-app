import type { DatabaseClient } from '../../../database/database.types';
import type { ExternalNotificationChannel, NotificationLevel } from '../domain/notification-rule.types';

export interface EnqueueNotificationChannelDeliveryInput {
  notificationRuleId: string;
  outboxEventId: string;
  userId: number;
  /** Только внешние каналы (telegram); `in_app` и `balloon` сюда не попадают (план 2026-10-03 R1-6). */
  channel: ExternalNotificationChannel;
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
