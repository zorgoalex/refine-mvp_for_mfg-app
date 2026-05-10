import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import type {
  CreatePaymentRequest,
  DeletePaymentResponse,
  PaymentDto,
  PaymentResponse,
  UpdatePaymentRequest,
} from './types/paymentApi.types';

export const paymentsApi = {
  async create(request: CreatePaymentRequest): Promise<PaymentDto> {
    const response = await httpClient.post<PaymentResponse>(apiRoutes.payments.list, request);
    return response.payment;
  },

  async update(paymentId: number, request: UpdatePaymentRequest): Promise<PaymentDto> {
    const response = await httpClient.patch<PaymentResponse>(
      apiRoutes.payments.byId(validatePaymentId(paymentId)),
      request,
    );
    return response.payment;
  },

  delete(paymentId: number): Promise<DeletePaymentResponse> {
    return httpClient.delete<DeletePaymentResponse>(
      apiRoutes.payments.byId(validatePaymentId(paymentId)),
    );
  },
};

export function validatePaymentId(paymentId: number): number {
  if (!Number.isInteger(paymentId) || paymentId < 1) {
    throw new Error('Invalid paymentId');
  }

  return paymentId;
}

