import type { CurrentUser } from '../current-user';
import { ROLE_POLICIES } from './role-policies';
import { allowsScope, type ScopedEntity } from './scope';

export interface OrderPolicySubject extends ScopedEntity {
  orderId: string | number;
}

export class OrderAccessPolicy {
  canCreate(user: CurrentUser): boolean {
    return user.permissions.includes('orders.create');
  }

  canView(user: CurrentUser, order: OrderPolicySubject): boolean {
    return (
      user.permissions.includes('orders.view') &&
      allowsScope(user, ROLE_POLICIES[user.role].orders.view, order)
    );
  }

  canUpdate(user: CurrentUser, order: OrderPolicySubject): boolean {
    return (
      user.permissions.includes('orders.update') &&
      allowsScope(user, ROLE_POLICIES[user.role].orders.update, order)
    );
  }

  canExport(user: CurrentUser, order: OrderPolicySubject): boolean {
    return (
      user.permissions.includes('orders.export') &&
      allowsScope(user, ROLE_POLICIES[user.role].orders.export, order)
    );
  }

  canDelete(user: CurrentUser, order: OrderPolicySubject): boolean {
    return (
      user.permissions.includes('orders.delete') &&
      allowsScope(user, ROLE_POLICIES[user.role].orders.delete, order)
    );
  }
}
