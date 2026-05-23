import type { DatabaseClient } from '../../../database/database.types';
import type {
  DeadlineNotificationInput,
  DeadlineNotificationPort,
  DeadlineNotificationResult,
} from '../application/deadline.types';

interface NotificationRow {
  notification_id: string;
  created_at: string;
}

export class PgDeadlineNotificationPort implements DeadlineNotificationPort {
  constructor(private readonly database: DatabaseClient) {}

  async createNotification(input: DeadlineNotificationInput): Promise<DeadlineNotificationResult> {
    const inserted = await this.database.query<NotificationRow>(
      `
      INSERT INTO notifications (
        user_id, level, title, message, entity_type, entity_id, source_type, source_id,
        idempotency_key
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
      RETURNING notification_id, created_at
      `,
      [
        input.userId,
        input.level,
        input.title,
        input.message,
        input.entityType ?? null,
        input.entityId ?? null,
        input.sourceType,
        input.sourceId,
        input.idempotencyKey,
      ],
    );

    const insertedRow = inserted.rows[0];
    if (insertedRow) {
      return {
        created: true,
        notificationId: String(insertedRow.notification_id),
      };
    }

    const existing = await this.database.query<NotificationRow>(
      `
      SELECT notification_id, created_at
      FROM notifications
      WHERE idempotency_key = $1
      `,
      [input.idempotencyKey],
    );

    return {
      created: false,
      notificationId: existing.rows[0]?.notification_id
        ? String(existing.rows[0].notification_id)
        : null,
    };
  }
}
