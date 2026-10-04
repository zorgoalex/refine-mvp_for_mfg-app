import type { DatabaseClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { mapRoleIdToRole } from '../../../permissions/permissions';
import { scopesFromRows, type RoleAuthorizationSnapshot } from '../../../permissions/permissions.service';
import { buildScopedOrderWhere } from '../../orders/adapters/pg-order-resource-demand-repository';
import type { NotificationEventContext } from '../domain/notification-rule.types';
import type { VisibilityPort } from '../ports/visibility.port';

const PROCUREMENT_VIEW = 'procurement.view';

type RoleAuthorization = Pick<RoleAuthorizationSnapshot, 'permissions' | 'scopes'>;

/**
 * Матрица роли — тем же запросом, что и `PermissionsService.loadRoleAuthorization`, но через ПЕРЕДАННОЕ соединение
 * транзакции реле (4б CR2-1: второе соединение из пула внутри транзакции зависает при малом пуле). Засев матрицы по
 * умолчанию здесь не выполняется (это делает вход в систему); нет строк — нет прав и scope 'none' (fail closed).
 */
export async function loadRoleAuthorizationWith(client: DatabaseClient, roleId: number): Promise<RoleAuthorization> {
  const permissions = await client.query<{ permission_name: string }>(
    `SELECT rp.permission_name
       FROM role_permissions rp
       JOIN permissions_catalog pc ON pc.permission_name = rp.permission_name
       JOIN roles r ON r.role_id = rp.role_id AND r.is_active = true
      WHERE rp.role_id = $1 AND rp.is_enabled = true AND pc.is_active = true`,
    [roleId],
  );
  const scopes = await client.query<{ scope_key: string; scope_value: string }>(
    'SELECT scope_key, scope_value FROM role_policy_scopes WHERE role_id = $1',
    [roleId],
  );
  return {
    permissions: permissions.rows.map((row) => row.permission_name) as RoleAuthorization['permissions'],
    scopes: scopesFromRows(scopes.rows),
  };
}

/**
 * Получатели уведомлений закупа (§5.7, 4б CR1-1): ТЕКУЩИЕ права и scope из матрицы ролей (как при входе), а не
 * статические умолчания роли. Получатель остаётся, только если у его роли буквальное `procurement.view` и заказ события
 * в его scope `orders.view` (own / assigned / all — тем же предикатом, что и экран снабжения; корзина — нет). Без заказа
 * в событии — никого (fail closed). Чтение повторно фильтрует то же самое (pg-notification-repository).
 */
export class PgProcurementRecipientVisibility implements VisibilityPort {

  async filterByBaseVisibility(client: DatabaseClient, userIds: number[], ctx: NotificationEventContext): Promise<number[]> {
    if (userIds.length === 0 || ctx.orderId == null) return [];
    const users = await client.query<{ user_id: string; username: string | null; role_id: string | number }>(
      `SELECT user_id::text AS user_id, username, role_id FROM users
        WHERE user_id = ANY($1::bigint[]) AND is_active = true
        ORDER BY user_id`,
      [userIds],
    );
    const byRole = new Map<number, RoleAuthorization>();
    const allowed: number[] = [];
    for (const row of users.rows) {
      const roleId = Number(row.role_id);
      const role = mapRoleIdToRole(roleId);
      if (!role) continue;
      if (!byRole.has(roleId)) byRole.set(roleId, await loadRoleAuthorizationWith(client, roleId));
      const authorization = byRole.get(roleId)!;
      if (!authorization.permissions.includes(PROCUREMENT_VIEW)) continue;
      const viewer: CurrentUser = {
        id: row.user_id,
        username: row.username ?? row.user_id,
        role,
        roleId,
        permissions: authorization.permissions,
        policyScopes: authorization.scopes,
      };
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
      if ((visible.rowCount ?? 0) > 0) allowed.push(Number(row.user_id));
    }
    return userIds.filter((id) => allowed.includes(id));
  }
}
