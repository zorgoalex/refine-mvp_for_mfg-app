import type { CurrentUser } from '../current-user';
import { allowsScope, rolePolicyForUser, type ScopedEntity } from './scope';

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
      allowsScope(user, rolePolicyForUser(user).orders.view, order)
    );
  }

  canUpdate(user: CurrentUser, order: OrderPolicySubject): boolean {
    return (
      user.permissions.includes('orders.update') &&
      allowsScope(user, rolePolicyForUser(user).orders.update, order)
    );
  }

  canExport(user: CurrentUser, order: OrderPolicySubject): boolean {
    return (
      user.permissions.includes('orders.export') &&
      allowsScope(user, rolePolicyForUser(user).orders.export, order)
    );
  }

  canDelete(user: CurrentUser, order: OrderPolicySubject): boolean {
    return (
      user.permissions.includes('orders.delete') &&
      allowsScope(user, rolePolicyForUser(user).orders.delete, order)
    );
  }
}
