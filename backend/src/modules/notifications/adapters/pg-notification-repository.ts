import type { DatabaseClient } from '../../../database/database.types';
import type {
  NotificationDto,
  NotificationLevel,
  NotificationListResult,
  NotificationRepositoryPort,
} from '../application/notification.types';

interface NotificationRow {
  notification_id: string;
  user_id: string;
  level: NotificationLevel;
  title: string | null;
  message: string;
  entity_type: string | null;
  entity_id: string | null;
  source_type: string | null;
  source_id: string | null;
  read_at: string | null;
  created_at: string;
  total_count?: string | number | null;
  unread_count?: string | number | null;
}

export class PgNotificationRepository implements NotificationRepositoryPort {
  constructor(private readonly database: DatabaseClient) {}

  async listForUser(input: {
    userId: string;
    unreadOnly: boolean;
    page: number;
    pageSize: number;
  }): Promise<NotificationListResult> {
    const offset = (input.page - 1) * input.pageSize;
    const result = await this.database.query<NotificationRow>(
      `
      SELECT
        notification_id, user_id::text, level, title, message, entity_type, entity_id,
        source_type, source_id, read_at, created_at,
        count(*) OVER() AS total_count,
        count(*) FILTER (WHERE read_at IS NULL) OVER() AS unread_count
      FROM notifications
      WHERE user_id = $1
        AND ($2::boolean = false OR read_at IS NULL)
      ORDER BY created_at DESC, notification_id DESC
      LIMIT $3 OFFSET $4
      `,
      [input.userId, input.unreadOnly, input.pageSize, offset],
    );

    const first = result.rows[0];
    return {
      data: result.rows.map(mapRow),
      total: numberFromCount(first?.total_count),
      unreadCount: numberFromCount(first?.unread_count),
    };
  }

  async markReadForUser(input: {
    notificationId: string;
    userId: string;
  }): Promise<NotificationDto | null> {
    const result = await this.database.query<NotificationRow>(
      `
      UPDATE notifications
      SET read_at = COALESCE(read_at, now())
      WHERE notification_id = $1
        AND user_id = $2
      RETURNING notification_id, user_id::text, level, title, message, entity_type, entity_id,
        source_type, source_id, read_at, created_at
      `,
      [input.notificationId, input.userId],
    );

    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async markAllReadForUser(userId: string): Promise<number> {
    const result = await this.database.query<{ updated_count: string | number }>(
      `
      WITH updated AS (
        UPDATE notifications
        SET read_at = COALESCE(read_at, now())
        WHERE user_id = $1
          AND read_at IS NULL
        RETURNING notification_id
      )
      SELECT count(*) AS updated_count FROM updated
      `,
      [userId],
    );

    return numberFromCount(result.rows[0]?.updated_count);
  }

  async deleteForUser(input: { notificationId: string; userId: string }): Promise<boolean> {
    const result = await this.database.query(
      `
      DELETE FROM notifications
      WHERE notification_id = $1
        AND user_id = $2
      `,
      [input.notificationId, input.userId],
    );

    return (result.rowCount ?? 0) > 0;
  }
}

function mapRow(row: NotificationRow): NotificationDto {
  return {
    notificationId: String(row.notification_id),
    userId: String(row.user_id),
    level: row.level,
    title: row.title,
    message: row.message,
    entityType: row.entity_type,
    entityId: row.entity_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    readAt: row.read_at,
    createdAt: row.created_at,
  };
}

function numberFromCount(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return Number(value);
}
