import type { DatabaseClient } from '../../../database/database.types';
import { PROCUREMENT_NOTIFICATION_SOURCES } from '../../notifications-engine/domain/notification-event-registry';
import { buildScopedOrderWhere } from '../../orders/adapters/pg-order-resource-demand-repository';
import type {
  NotificationDto,
  NotificationLevel,
  NotificationListResult,
  NotificationRepositoryPort,
  NotificationViewer,
} from '../application/notification.types';

const PROCUREMENT_VIEW = 'procurement.view';

/**
 * Видимость строки уведомления для читателя (§5.7 R5-1): уведомления закупа — только при буквальном
 * `procurement.view` и, если привязаны к заказу, только пока заказ в ТЕКУЩЕМ scope читателя (не в корзине). Остальные
 * источники — без изменений. Скрытые строки не удаляются: вернётся доступ — снова видны (непрочитанными, если были).
 * Предикат дописывает свои параметры в `params`; алиас строки уведомления — `n`.
 */
export function notificationVisibilitySql(viewer: NotificationViewer, params: unknown[]): string {
  const sourcesIndex = params.push([...PROCUREMENT_NOTIFICATION_SOURCES]);
  const other = `n.source_type <> ALL($${sourcesIndex}::text[])`;
  if (!viewer.permissions.includes(PROCUREMENT_VIEW)) return other;
  const { whereSql } = buildScopedOrderWhere(viewer, undefined, params);
  return `(${other}
        OR n.entity_type IS DISTINCT FROM 'order'
        OR EXISTS (
          SELECT 1 FROM orders o
            JOIN projects p ON p.project_id = o.project_id
            LEFT JOIN clients c ON c.client_id = o.client_id
           WHERE ${whereSql} AND o.order_id::text = n.entity_id))`;
}

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
  read_at: string | Date | null;
  created_at: string | Date;
}

interface NotificationCountRow {
  total_count: string | number | null;
  unread_count: string | number | null;
}

export class PgNotificationRepository implements NotificationRepositoryPort {
  constructor(private readonly database: DatabaseClient) {}

  async listForUser(input: {
    viewer: NotificationViewer;
    unreadOnly: boolean;
    page: number;
    pageSize: number;
  }): Promise<NotificationListResult> {
    const offset = (input.page - 1) * input.pageSize;
    const countParams: unknown[] = [input.viewer.id, input.unreadOnly];
    const countVisible = notificationVisibilitySql(input.viewer, countParams);
    const counts = await this.database.query<NotificationCountRow>(
      `
      SELECT
        count(*) FILTER (WHERE ($2::boolean = false OR is_read = false)) AS total_count,
        count(*) FILTER (WHERE is_read = false) AS unread_count
      FROM notifications n
      WHERE user_id = $1
        AND ${countVisible}
      `,
      countParams,
    );
    const listParams: unknown[] = [input.viewer.id, input.unreadOnly, input.pageSize, offset];
    const listVisible = notificationVisibilitySql(input.viewer, listParams);
    const notifications = await this.database.query<NotificationRow>(
      `
      SELECT
        notification_id, user_id::text, level, title, message, entity_type, entity_id,
        source_type, source_id, read_at, created_at
      FROM notifications n
      WHERE user_id = $1
        AND ($2::boolean = false OR is_read = false)
        AND ${listVisible}
      ORDER BY created_at DESC, notification_id DESC
      LIMIT $3 OFFSET $4
      `,
      listParams,
    );

    const countRow = counts.rows[0];
    return {
      data: notifications.rows.map(mapRow),
      total: numberFromCount(countRow?.total_count),
      unreadCount: numberFromCount(countRow?.unread_count),
    };
  }

  async markReadForUser(input: {
    notificationId: string;
    viewer: NotificationViewer;
  }): Promise<NotificationDto | null> {
    const params: unknown[] = [input.notificationId, input.viewer.id];
    const visible = notificationVisibilitySql(input.viewer, params);
    // Скрытая строка (нет права/scope) — как отсутствующая: 404, не меняется.
    const result = await this.database.query<NotificationRow>(
      `
      UPDATE notifications n
      SET is_read = true,
        read_at = COALESCE(read_at, now())
      WHERE notification_id = $1
        AND user_id = $2
        AND ${visible}
      RETURNING notification_id, user_id::text, level, title, message, entity_type, entity_id,
        source_type, source_id, read_at, created_at
      `,
      params,
    );

    return result.rows[0] ? mapRow(result.rows[0]) : null;
  }

  async markAllReadForUser(viewer: NotificationViewer): Promise<number> {
    const params: unknown[] = [viewer.id];
    const visible = notificationVisibilitySql(viewer, params);
    // Тот же предикат прямо в массовом UPDATE (R6-2): скрытые строки не помечаются и не считаются.
    const result = await this.database.query<{ updated_count: string | number }>(
      `
      WITH updated AS (
        UPDATE notifications n
        SET is_read = true,
          read_at = COALESCE(read_at, now())
        WHERE user_id = $1
          AND is_read = false
          AND ${visible}
        RETURNING notification_id
      )
      SELECT count(*) AS updated_count FROM updated
      `,
      params,
    );

    return numberFromCount(result.rows[0]?.updated_count);
  }

  async deleteForUser(input: { notificationId: string; viewer: NotificationViewer }): Promise<boolean> {
    const params: unknown[] = [input.notificationId, input.viewer.id];
    const visible = notificationVisibilitySql(input.viewer, params);
    const result = await this.database.query(
      `
      DELETE FROM notifications n
      WHERE notification_id = $1
        AND user_id = $2
        AND ${visible}
      `,
      params,
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
    readAt: timestampToIsoString(row.read_at),
    createdAt: timestampToIsoString(row.created_at),
  };
}

function timestampToIsoString(value: string | Date): string;
function timestampToIsoString(value: string | Date | null): string | null;
function timestampToIsoString(value: string | Date | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function numberFromCount(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return Number(value);
}
