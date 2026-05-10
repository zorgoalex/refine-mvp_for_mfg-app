import { ApiError } from '../../../common/errors/api-error';

export class PaymentNotFoundError extends ApiError {
  constructor(paymentId: number) {
    super(404, 'PAYMENT_NOT_FOUND', 'Payment not found', { paymentId });
  }
}

export class PaymentOrderNotFoundError extends ApiError {
  constructor(orderId: number) {
    super(404, 'ORDER_NOT_FOUND', 'Order not found', { orderId });
  }
}

