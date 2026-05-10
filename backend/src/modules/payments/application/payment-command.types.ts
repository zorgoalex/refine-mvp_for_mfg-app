import type { CurrentUser } from '../../../permissions/current-user';
import type {
  CreatePaymentRequestDto,
  DeletePaymentResponseDto,
  PaymentDto,
  PaymentOrderSummaryDto,
  UpdatePaymentRequestDto,
} from '../dto/payment.dto';

export interface CreatePaymentCommand {
  currentUser: CurrentUser;
  dto: CreatePaymentRequestDto;
  requestId?: string;
}

export interface UpdatePaymentCommand {
  currentUser: CurrentUser;
  paymentId: number;
  dto: UpdatePaymentRequestDto;
  requestId?: string;
}

export interface DeletePaymentCommand {
  currentUser: CurrentUser;
  paymentId: number;
  requestId?: string;
}

export interface PaymentMutationResult {
  payment: PaymentDto;
  order: PaymentOrderSummaryDto;
}

export interface PaymentRepositoryPort {
  createPayment(command: CreatePaymentCommand): Promise<PaymentMutationResult>;
  updatePayment(command: UpdatePaymentCommand): Promise<PaymentMutationResult>;
  deletePayment(command: DeletePaymentCommand): Promise<DeletePaymentResponseDto>;
}

