import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type {
  DeadlineTransactionManagerPort,
  DeadlineUnitOfWork,
} from '../application/deadline.types';
import { PgDeadlineRepository } from './pg-deadline-repository';

export class PgDeadlineTransactionManager implements DeadlineTransactionManagerPort {
  constructor(private readonly database: DatabaseService) {}

  runInTransaction<T>(handler: (unitOfWork: DeadlineUnitOfWork) => Promise<T>): Promise<T> {
    return this.database.transaction((tx) => handler(new PgDeadlineUnitOfWork(tx)));
  }
}

class PgDeadlineUnitOfWork implements DeadlineUnitOfWork {
  readonly deadlines: PgDeadlineRepository;

  constructor(tx: TransactionClient) {
    this.deadlines = new PgDeadlineRepository(tx);
  }
}
