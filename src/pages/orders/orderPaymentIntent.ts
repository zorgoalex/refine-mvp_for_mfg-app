export const ADD_PAYMENT_INTENT_PARAM = 'addPayment';

export function createAddPaymentIntentId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function buildOrderEditAddPaymentPath(
  orderId: number,
  intentId = createAddPaymentIntentId(),
): string {
  const params = new URLSearchParams({
    tab: 'finance',
    [ADD_PAYMENT_INTENT_PARAM]: intentId,
  });

  return `/orders/edit/${orderId}?${params.toString()}`;
}

export function readAddPaymentIntent(search: string): string | null {
  const value = new URLSearchParams(search).get(ADD_PAYMENT_INTENT_PARAM)?.trim();
  return value || null;
}

export function clearAddPaymentIntent(search: string): string {
  const params = new URLSearchParams(search);
  params.delete(ADD_PAYMENT_INTENT_PARAM);
  const nextSearch = params.toString();
  return nextSearch ? `?${nextSearch}` : '';
}
