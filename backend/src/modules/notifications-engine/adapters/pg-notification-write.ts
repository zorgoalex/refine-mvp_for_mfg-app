import type { DatabaseClient } from '../../../database/database.types';
import type { InsertNotificationInput, NotificationWritePort } from '../ports/notification-write.port';

export class PgNotificationWriteAdapter implements NotificationWritePort {
  async insertIfAbsent(client: DatabaseClient, input: InsertNotificationInput): Promise<{ created: boolean; notificationId: string }> {
    const inserted = await client.query<{ notification_id: string }>(
      `INSERT INTO notifications
         (user_id, level, title, message, entity_type, entity_id, source_type, source_id, idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
       RETURNING notification_id`,
      [input.userId, input.level, input.title, input.message, input.entityType, input.entityId, input.sourceType, input.sourceId, input.idempotencyKey],
    );
    if (inserted.rows[0]) {
      return { created: true, notificationId: String(inserted.rows[0].notification_id) };
    }
    const existing = await client.query<{ notification_id: string }>(
      `SELECT notification_id FROM notifications WHERE idempotency_key = $1`,
      [input.idempotencyKey],
    );
    return { created: false, notificationId: String(existing.rows[0].notification_id) };
  }
}
