import type { CurrentUser } from '../current-user';
import { allowsScopeSet, policyScopeSetsForUser, type ScopedEntity } from './scope';

export interface PaymentPolicySubject extends ScopedEntity {
  paymentId: string | number;
  order: ScopedEntity;
}

export class PaymentAccessPolicy {
  canCreate(user: CurrentUser, payment: PaymentPolicySubject): boolean {
    return (
      user.permissions.includes('payments.create') &&
      allowsScopeSet(user, policyScopeSetsForUser(user).payments.create, payment.order)
    );
  }

  canView(user: CurrentUser, payment: PaymentPolicySubject): boolean {
    return (
      user.permissions.includes('payments.view') &&
      allowsScopeSet(user, policyScopeSetsForUser(user).payments.view, payment.order)
    );
  }

  canUpdate(user: CurrentUser, payment: PaymentPolicySubject): boolean {
    return (
      user.permissions.includes('payments.update') &&
      allowsScopeSet(user, policyScopeSetsForUser(user).payments.update, payment.order)
    );
  }

  canDelete(user: CurrentUser, payment: PaymentPolicySubject): boolean {
    return (
      user.permissions.includes('payments.delete') &&
      allowsScopeSet(user, policyScopeSetsForUser(user).payments.delete, payment.order)
    );
  }
}
