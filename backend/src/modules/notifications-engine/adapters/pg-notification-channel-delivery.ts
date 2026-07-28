import type { DatabaseClient } from '../../../database/database.types';
import type {
  EnqueueNotificationChannelDeliveryInput,
  NotificationChannelDeliveryPort,
} from '../ports/notification-channel-delivery.port';

export class PgNotificationChannelDeliveryAdapter implements NotificationChannelDeliveryPort {
  async enqueueIfAbsent(
    client: DatabaseClient,
    input: EnqueueNotificationChannelDeliveryInput,
  ): Promise<{ created: boolean; deliveryId: string }> {
    const inserted = await client.query<{ notification_channel_delivery_id: string }>(
      `
      INSERT INTO notification_channel_deliveries (
        notification_rule_id, outbox_event_id, user_id, channel, level,
        title, message, entity_type, entity_id, source_type, source_id,
        idempotency_key
      )
      VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING notification_channel_delivery_id
      `,
      [
        input.notificationRuleId,
        input.outboxEventId,
        input.userId,
        input.channel,
        input.level,
        input.title,
        input.message,
        input.entityType,
        input.entityId,
        input.sourceType,
        input.sourceId,
        input.idempotencyKey,
      ],
    );
    const row = inserted.rows[0];
    if (row) {
      return {
        created: true,
        deliveryId: String(row.notification_channel_delivery_id),
      };
    }

    const existing = await client.query<{ notification_channel_delivery_id: string }>(
      `
      SELECT notification_channel_delivery_id
      FROM notification_channel_deliveries
      WHERE idempotency_key = $1
      `,
      [input.idempotencyKey],
    );

    return {
      created: false,
      deliveryId: String(existing.rows[0]?.notification_channel_delivery_id ?? ''),
    };
  }
}
