import type { DatabaseClient } from '../../../database/database.types';
import type { NotificationEventContext } from '../domain/notification-rule.types';
import type { VisibilityPort } from '../ports/visibility.port';
import { filterUserIdsByOrderVisibility } from '../../../permissions/visibility/order-visibility-filter';

export class PgVisibilityAdapter implements VisibilityPort {
  async filterByBaseVisibility(client: DatabaseClient, userIds: number[], ctx: NotificationEventContext): Promise<number[]> {
    if (userIds.length === 0) return [];
    // Order-context engine events anchor visibility on the order. Fail closed if no order anchor.
    if (ctx.orderId == null) return [];
    const allowed = await filterUserIdsByOrderVisibility(client, userIds.map(String), String(ctx.orderId));
    return userIds.filter((id) => allowed.has(String(id)));
  }
}
