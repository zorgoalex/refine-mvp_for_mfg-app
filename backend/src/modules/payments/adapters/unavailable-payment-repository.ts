import { ApiError } from '../../../common/errors/api-error';
import type {
  CreatePaymentCommand,
  DeletePaymentCommand,
  PaymentRepositoryPort,
  UpdatePaymentCommand,
} from '../application/payment-command.types';

export class UnavailablePaymentRepository implements PaymentRepositoryPort {
  createPayment(_command: CreatePaymentCommand) {
    return Promise.reject(unavailable());
  }

  updatePayment(_command: UpdatePaymentCommand) {
    return Promise.reject(unavailable());
  }

  deletePayment(_command: DeletePaymentCommand) {
    return Promise.reject(unavailable());
  }
}

function unavailable(): ApiError {
  return new ApiError(503, 'DATABASE_UNAVAILABLE', 'Database is not configured');
}

