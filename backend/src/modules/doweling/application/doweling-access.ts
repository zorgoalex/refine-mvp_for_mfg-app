import type { CurrentUser } from '../../../permissions/current-user';
import { OrderAccessPolicy } from '../../../permissions/policies/order-access.policy';

/** An order a doweling order is (or will be) linked to, as read under lock. */
export interface DowelingLinkedOrder {
  orderId: number;
  createdByUserId: string | null;
  managerUserId: string | null;
  deleted: boolean;
  productionOrder: boolean;
}

export type DowelingAccessDecision =
  | { kind: 'allowed' }
  /** A currently linked order is invisible to the user, so the doweling order itself is: «not found». */
  | { kind: 'doweling_hidden'; orderIds: number[] }
  /** An order to link does not exist, is deleted, is not a production order or is invisible: «not found». */
  | { kind: 'order_not_found'; orderIds: number[] }
  | { kind: 'denied'; orderIds: number[] };

const policy = new OrderAccessPolicy();

function subject(order: DowelingLinkedOrder) {
  return { orderId: order.orderId, createdByUserId: order.createdByUserId, managerUserId: order.managerUserId };
}

/**
 * Who may change a doweling order and its links — the backend twin of the Hasura «write» predicate of access groups 0Б
 * and of the order save: every order the doweling order is linked to now (active links and the legacy `order_id`) and
 * every order it gets linked to must be updatable by the user (`orders.update` + scope). Orders being added must exist,
 * be live production orders and be readable by the user (the read visibility of orders, as in `readableOrderIds`); a currently linked order the user cannot see hides the doweling
 * order itself (the read predicate requires all of them).
 */
export function decideDowelingWrite(
  user: CurrentUser,
  input: {
    currentOrderIds: readonly number[];
    addedOrderIds: readonly number[];
    orders: ReadonlyMap<number, DowelingLinkedOrder>;
    /** Orders the user may read (`readableOrderIds`); null = reads are unrestricted. */
    readableOrderIds: ReadonlySet<number> | null;
  },
): DowelingAccessDecision {
  const visible = (orderId: number) => input.readableOrderIds === null || input.readableOrderIds.has(orderId);
  const hidden: number[] = [];
  const denied: number[] = [];

  for (const orderId of input.currentOrderIds) {
    const order = input.orders.get(orderId);
    // A link always references an existing order (FK); a missing row means it vanished concurrently — not ours to edit.
    if (!order || !visible(orderId)) {
      hidden.push(orderId);
    } else if (!policy.canUpdate(user, subject(order))) {
      denied.push(orderId);
    }
  }
  if (hidden.length > 0) {
    return { kind: 'doweling_hidden', orderIds: hidden };
  }

  const missing: number[] = [];
  for (const orderId of input.addedOrderIds) {
    const order = input.orders.get(orderId);
    if (!order || order.deleted || !order.productionOrder || !visible(orderId)) {
      missing.push(orderId);
    } else if (!policy.canUpdate(user, subject(order))) {
      denied.push(orderId);
    }
  }
  if (missing.length > 0) {
    return { kind: 'order_not_found', orderIds: missing };
  }
  return denied.length > 0 ? { kind: 'denied', orderIds: denied } : { kind: 'allowed' };
}
