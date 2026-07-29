import { describe, expect, it } from 'vitest';
import {
  buildOrderEditAddPaymentPath,
  clearAddPaymentIntent,
  readAddPaymentIntent,
} from './orderPaymentIntent';

describe('order payment navigation intent', () => {
  it('opens the edit form on Finance with a unique inline-payment intent', () => {
    expect(buildOrderEditAddPaymentPath(42, 'payment-intent-1')).toBe(
      '/orders/edit/42?tab=finance&addPayment=payment-intent-1',
    );
  });

  it('reads and consumes only the add-payment parameter', () => {
    const search = '?tab=finance&addPayment=payment-intent-1&source=show';

    expect(readAddPaymentIntent(search)).toBe('payment-intent-1');
    expect(clearAddPaymentIntent(search)).toBe('?tab=finance&source=show');
  });

  it('ignores an empty add-payment parameter', () => {
    expect(readAddPaymentIntent('?tab=finance&addPayment=')).toBeNull();
  });
});
