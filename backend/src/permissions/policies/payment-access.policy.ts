import type { CurrentUser } from '../current-user';
import { allowsScope, rolePolicyForUser, type ScopedEntity } from './scope';

export interface PaymentPolicySubject extends ScopedEntity {
  paymentId: string | number;
  order: ScopedEntity;
}

export class PaymentAccessPolicy {
  canCreate(user: CurrentUser, payment: PaymentPolicySubject): boolean {
    return (
      user.permissions.includes('payments.create') &&
      allowsScope(user, rolePolicyForUser(user).payments.create, payment.order)
    );
  }

  canView(user: CurrentUser, payment: PaymentPolicySubject): boolean {
    return (
      user.permissions.includes('payments.view') &&
      allowsScope(user, rolePolicyForUser(user).payments.view, payment.order)
    );
  }

  canUpdate(user: CurrentUser, payment: PaymentPolicySubject): boolean {
    return (
      user.permissions.includes('payments.update') &&
      allowsScope(user, rolePolicyForUser(user).payments.update, payment.order)
    );
  }

  canDelete(user: CurrentUser, payment: PaymentPolicySubject): boolean {
    return (
      user.permissions.includes('payments.delete') &&
      allowsScope(user, rolePolicyForUser(user).payments.delete, payment.order)
    );
  }
}
