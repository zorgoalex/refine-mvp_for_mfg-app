import { Injectable } from '@nestjs/common';
import type { DatabaseClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import { loadEvaluationUsersWith } from '../../../permissions/user-authorization-snapshot';
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
 * longer stop a delivery that has already started. The rights themselves come from the one
 * authorization snapshot every other path uses (`user_authorization_snapshot`), read in this transaction.
 */
@Injectable()
export class OrderSendActors {
  async load(tx: DatabaseClient, userId: string): Promise<CurrentUser | null> {
    await tx.query('SELECT version FROM permissions_state WHERE id = true FOR SHARE');
    const locked = (await tx.query<{ user_id: string }>(`SELECT u.user_id FROM users u JOIN roles r ON r.role_id = u.role_id
      WHERE u.user_id = $1 AND u.is_active AND r.is_active FOR SHARE OF u`, [userId])).rows[0];
    if (!locked) return null;
    return (await loadEvaluationUsersWith(tx, [userId], { requireActiveRole: true })).get(String(locked.user_id)) ?? null;
  }
}
