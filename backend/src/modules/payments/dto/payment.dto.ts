export interface PaymentDto {
  paymentId: number;
  orderId: number;
  typePaidId: number;
  amount: number;
  paymentDate: string;
  notes: string | null;
  refKey1c: string | null;
  createdBy: number | null;
  editedBy: number | null;
  createdAt: string;
  updatedAt: string | null;
}

export interface PaymentResponseDto {
  payment: PaymentDto;
  order: PaymentOrderSummaryDto;
}

export interface DeletePaymentResponseDto {
  paymentId: number;
  order: PaymentOrderSummaryDto;
  deleted: true;
}

export interface PaymentOrderSummaryDto {
  orderId: number;
  paidAmount: number;
  debtAmount: number;
  paymentDate: string | null;
  paymentStatusId: number;
  version: number;
}

export interface CreatePaymentRequestDto {
  orderId: number;
  typePaidId: number;
  amount: number;
  paymentDate: string;
  notes?: string | null;
  refKey1c?: string | null;
}

export interface UpdatePaymentRequestDto {
  orderId?: number;
  typePaidId?: number;
  amount?: number;
  paymentDate?: string;
  notes?: string | null;
  refKey1c?: string | null;
}

