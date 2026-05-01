import { deadlineAdapterUnavailableError } from '../errors/deadline.errors';
import type {
  DeadlineTransactionManagerPort,
  DeadlineUnitOfWork,
} from '../application/deadline.types';

export class UnavailableDeadlineTransactionManager implements DeadlineTransactionManagerPort {
  async runInTransaction<T>(
    _handler: (unitOfWork: DeadlineUnitOfWork) => Promise<T>,
  ): Promise<T> {
    throw deadlineAdapterUnavailableError('deadline_transaction_manager');
  }
}
