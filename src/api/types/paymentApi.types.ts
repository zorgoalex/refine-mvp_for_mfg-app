export type DateOnlyString = string;

export interface PaymentDto {
  paymentId: number;
  orderId: number;
  typePaidId: number;
  amount: number;
  paymentDate: DateOnlyString;
  notes: string | null;
  refKey1c: string | null;
  createdBy: number | null;
  editedBy: number | null;
  createdAt: string;
  updatedAt: string | null;
}

export interface PaymentOrderSummaryDto {
  orderId: number;
  paidAmount: number;
  debtAmount: number;
  paymentDate: DateOnlyString | null;
  paymentStatusId: number;
  version: number;
}

export interface PaymentResponse {
  payment: PaymentDto;
  order: PaymentOrderSummaryDto;
}

export interface DeletePaymentResponse {
  paymentId: number;
  order: PaymentOrderSummaryDto;
  deleted: true;
}

export interface CreatePaymentRequest {
  orderId: number;
  typePaidId: number;
  amount: number;
  paymentDate: DateOnlyString;
  notes?: string | null;
  refKey1c?: string | null;
}

export interface UpdatePaymentRequest {
  orderId?: number;
  typePaidId?: number;
  amount?: number;
  paymentDate?: DateOnlyString;
  notes?: string | null;
  refKey1c?: string | null;
}

