import { Injectable } from '@nestjs/common';
import type { DatabaseClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { mapRoleIdToRole, type PermissionName } from '../../../permissions/permissions';
import { scopesFromRows } from '../../../permissions/permissions.service';
import { OrderAccessPolicy } from '../../../permissions/policies/order-access.policy';
import { ORDER_SEND_FINANCIAL_PERMISSION, orderForm, type OrderFormCode } from './order-send.types';

export interface OrderAccessSubject { orderId: number; managerUserId: string | null; createdByUserId: string | null }

const policy = new OrderAccessPolicy();

/** «Как у экспорта»: view and export, each within its own scope; finances for a financial form. */
export function canSendOrder(user: CurrentUser, order: OrderAccessSubject, form?: OrderFormCode): boolean {
  if (!policy.canView(user, order) || !policy.canExport(user, order)) return false;
  return !form || !orderForm(form).financial || user.permissions.includes(ORDER_SEND_FINANCIAL_PERMISSION);
}

/** `lock` = FOR SHARE: the scope fields (manager, author) cannot change until the caller commits. */
export async function readAccessSubject(client: DatabaseClient, orderId: number, lock = false): Promise<OrderAccessSubject | null> {
  const row = (await client.query<{ manager_id: string | null; created_by: string | null }>(`SELECT manager_id, created_by FROM orders
    WHERE order_id = $1 AND delete_flag = false AND deleted_at IS NULL AND order_kind = 'production_order'${lock ? ' FOR SHARE' : ''}`, [orderId])).rows[0];
  if (!row) return null;
  return { orderId, managerUserId: row.manager_id === null ? null : String(row.manager_id), createdByUserId: row.created_by === null ? null : String(row.created_by) };
}

/**
 * The current rights of a user, read inside the intent transaction after its locks are held. The
 * authorization version row is share-locked, so a role/permission change and a user deactivation
 * wait for this transaction: whatever commits before it is seen, whatever comes after it can no
 * longer stop a delivery that has already started.
 */
@Injectable()
export class OrderSendActors {
  async load(tx: DatabaseClient, userId: string): Promise<CurrentUser | null> {
    await tx.query('SELECT version FROM permissions_state WHERE id = true FOR SHARE');
    const row = (await tx.query<{ user_id: string; username: string; role_id: number }>(`SELECT u.user_id, u.username, u.role_id
      FROM users u JOIN roles r ON r.role_id = u.role_id WHERE u.user_id = $1 AND u.is_active AND r.is_active FOR SHARE OF u`, [userId])).rows[0];
    if (!row) return null;
    const roleId = Number(row.role_id);
    const role = mapRoleIdToRole(roleId);
    if (!role) return null;
    const [permissions, scopes] = await Promise.all([
      tx.query<{ permission_name: PermissionName }>(`SELECT rp.permission_name FROM role_permissions rp
        JOIN permissions_catalog pc ON pc.permission_name = rp.permission_name
        WHERE rp.role_id = $1 AND rp.is_enabled = true AND pc.is_active = true`, [roleId]),
      tx.query<{ scope_key: string; scope_value: string }>('SELECT scope_key, scope_value FROM role_policy_scopes WHERE role_id = $1', [roleId]),
    ]);
    return { id: String(row.user_id), username: row.username, role, roleId, permissions: permissions.rows.map((item) => item.permission_name),
      policyScopes: scopesFromRows(scopes.rows) };
  }
}
