import { describe, it, expect } from 'vitest';
import { buildPaymentDeniedEvent } from './payments-audit';

describe('buildPaymentDeniedEvent', () => {
  it('builds a query-ready scoped denied payment event', () => {
    const e = buildPaymentDeniedEvent({
      currentUser: { id: 9, username: 'm', role: 'manager' } as any,
      requestId: 'req_p', action: 'update', orderId: 11192, paymentId: 5,
    });
    expect(e).toMatchObject({
      event: 'payment.permission_denied', entityType: 'payment', entityId: 5,
      source: 'backend-payments-command', relatedOrderId: 11192, relatedPaymentId: 5,
      reason: 'order_scope_denied', requiredPermissions: ['payments.update'],
    });
  });
});
