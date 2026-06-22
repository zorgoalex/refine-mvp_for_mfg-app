import type { DeniedAuditEvent } from '../../../common/audit/audit-event.types';
import type { CurrentUser } from '../../../permissions/current-user';

export const PAYMENTS_AUDIT_SOURCE = 'backend-payments-command'; // reuse existing command-source (pg-payment-repository.ts:350)
export const PAYMENT_PERMISSION_DENIED = 'payment.permission_denied';

export interface BuildPaymentDeniedInput {
  currentUser: CurrentUser;
  requestId: string;
  action: 'create' | 'update' | 'delete';
  orderId?: number | null;
  paymentId?: number | null;
}

export function buildPaymentDeniedEvent(input: BuildPaymentDeniedInput): DeniedAuditEvent {
  return {
    event: PAYMENT_PERMISSION_DENIED, entityType: 'payment',
    entityId: input.paymentId ?? 'payments',
    actorUserId: input.currentUser.id, actorUsername: input.currentUser.username ?? null,
    actorRole: input.currentUser.role ?? null, requestId: input.requestId,
    source: PAYMENTS_AUDIT_SOURCE,
    relatedOrderId: input.orderId ?? null, relatedPaymentId: input.paymentId ?? null,
    reason: 'order_scope_denied', requiredPermissions: [`payments.${input.action}`],
  };
}
