import { ApiError } from '../../../common/errors/api-error';
import type {
  RestoreOrderCommand,
  OrderTransactionManagerPort,
  OrderWriteUnitOfWork,
} from '../application/order-transaction.types';

export class UnavailableOrderTransactionManager implements OrderTransactionManagerPort {
  async runInTransaction<T>(
    _handler: (unitOfWork: OrderWriteUnitOfWork) => Promise<T>,
  ): Promise<T> {
    throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Orders DB adapter is not configured', {
      module: 'orders',
    });
  }

  async markOrderRestoreIdempotencyFailed(_command: RestoreOrderCommand): Promise<void> {
    throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Orders DB adapter is not configured', {
      module: 'orders',
    });
  }
}
