import type { CurrentUser } from '../current-user';
import { ROLE_POLICIES } from './role-policies';
import { allowsScope, type ScopedEntity } from './scope';

export interface PaymentPolicySubject extends ScopedEntity {
  paymentId: string | number;
  order: ScopedEntity;
}

export class PaymentAccessPolicy {
  canCreate(user: CurrentUser, payment: PaymentPolicySubject): boolean {
    return (
      user.permissions.includes('payments.create') &&
      allowsScope(user, ROLE_POLICIES[user.role].payments.create, payment.order)
    );
  }

  canView(user: CurrentUser, payment: PaymentPolicySubject): boolean {
    return (
      user.permissions.includes('payments.view') &&
      allowsScope(user, ROLE_POLICIES[user.role].payments.view, payment.order)
    );
  }

  canUpdate(user: CurrentUser, payment: PaymentPolicySubject): boolean {
    return (
      user.permissions.includes('payments.update') &&
      allowsScope(user, ROLE_POLICIES[user.role].payments.update, payment.order)
    );
  }

  canDelete(user: CurrentUser, payment: PaymentPolicySubject): boolean {
    return (
      user.permissions.includes('payments.delete') &&
      allowsScope(user, ROLE_POLICIES[user.role].payments.delete, payment.order)
    );
  }
}
