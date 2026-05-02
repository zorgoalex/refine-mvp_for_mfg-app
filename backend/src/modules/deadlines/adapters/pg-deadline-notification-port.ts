import type { DatabaseClient } from '../../../database/database.types';
import type { DeadlineNotificationPort } from '../application/deadline.types';

export class PgDeadlineNotificationPort implements DeadlineNotificationPort {
  constructor(private readonly database: DatabaseClient) {}

  async createNotification(input: {
    userId: number;
    level: 'info' | 'warning' | 'error';
    title: string;
    message: string;
    entityType?: string | null;
    entityId?: string | null;
    sourceType: 'deadline';
    sourceId: string;
  }): Promise<void> {
    await this.database.query(
      `
      INSERT INTO notifications (
        user_id, level, title, message, entity_type, entity_id, source_type, source_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
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
      ],
    );
  }
}
