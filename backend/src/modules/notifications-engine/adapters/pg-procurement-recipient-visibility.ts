import type { DatabaseClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { loadEvaluationUsersWith } from '../../../permissions/user-authorization-snapshot';
import { buildScopedOrderWhere } from '../../orders/adapters/pg-order-resource-demand-repository';
import type { NotificationEventContext } from '../domain/notification-rule.types';
import type { VisibilityPort } from '../ports/visibility.port';

const PROCUREMENT_VIEW = 'procurement.view';

/**
 * Получатели уведомлений закупа (§5.7, 4б CR1-1): ТЕКУЩИЕ права и scope из матрицы ролей (как при входе), а не
 * статические умолчания роли. Получатель остаётся, только если у его роли буквальное `procurement.view` и заказ события
 * в его scope `orders.view` (own / assigned / all — тем же предикатом, что и экран снабжения; корзина — нет). Без заказа
 * в событии — никого (fail closed). Чтение повторно фильтрует то же самое (pg-notification-repository).
 */
export class PgProcurementRecipientVisibility implements VisibilityPort {

  async filterByBaseVisibility(client: DatabaseClient, userIds: number[], ctx: NotificationEventContext): Promise<number[]> {
    if (userIds.length === 0 || ctx.orderId == null) return [];
    // Effective authorization (same snapshot as the token), through the relay's transaction connection.
    const effective = await loadEvaluationUsersWith(client, userIds, { requireActiveRole: true });
    const allowed: number[] = [];
    for (const userId of [...new Set(userIds)].sort((a, b) => a - b)) {
      const viewer = effective.get(String(userId));
      if (!viewer || !viewer.permissions.includes(PROCUREMENT_VIEW)) continue;
      const params: unknown[] = [];
      const { whereSql } = buildScopedOrderWhere(viewer, ctx.orderId, params);
      const visible = await client.query(
        `SELECT 1 FROM orders o
           JOIN projects p ON p.project_id = o.project_id
           LEFT JOIN clients c ON c.client_id = o.client_id
          WHERE ${whereSql}
          LIMIT 1`,
        params,
      );
      if ((visible.rowCount ?? 0) > 0) allowed.push(userId);
    }
    return userIds.filter((id) => allowed.includes(id));
  }
}
