import type { CurrentUser } from '../current-user';
import { allowsScopeSet, policyScopeSetsForUser, type ScopedEntity } from './scope';

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
      allowsScopeSet(user, policyScopeSetsForUser(user).orders.view, order)
    );
  }

  canUpdate(user: CurrentUser, order: OrderPolicySubject): boolean {
    return (
      user.permissions.includes('orders.update') &&
      allowsScopeSet(user, policyScopeSetsForUser(user).orders.update, order)
    );
  }

  canExport(user: CurrentUser, order: OrderPolicySubject): boolean {
    return (
      user.permissions.includes('orders.export') &&
      allowsScopeSet(user, policyScopeSetsForUser(user).orders.export, order)
    );
  }

  canDelete(user: CurrentUser, order: OrderPolicySubject): boolean {
    return (
      user.permissions.includes('orders.delete') &&
      allowsScopeSet(user, policyScopeSetsForUser(user).orders.delete, order)
    );
  }
}
