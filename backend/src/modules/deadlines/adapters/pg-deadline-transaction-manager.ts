import { DatabaseService } from '../../../database/database.service';
import type { TransactionClient } from '../../../database/database.types';
import type {
  DeadlineTransactionManagerPort,
  DeadlineUnitOfWork,
} from '../application/deadline.types';
import {
  changeOrderStatusFromDeadlineInTransaction,
  changeProductionStatusFromDeadlineInTransaction,
} from '../../production-actions/adapters/pg-production-action-repository';
import { PgDeadlineRepository } from './pg-deadline-repository';

export class PgDeadlineTransactionManager implements DeadlineTransactionManagerPort {
  constructor(private readonly database: DatabaseService) {}

  runInTransaction<T>(handler: (unitOfWork: DeadlineUnitOfWork) => Promise<T>): Promise<T> {
    return this.database.transaction((tx) => handler(new PgDeadlineUnitOfWork(tx)));
  }
}

class PgDeadlineUnitOfWork implements DeadlineUnitOfWork {
  readonly deadlines: PgDeadlineRepository;
  readonly statusActionPort: DeadlineUnitOfWork['statusActionPort'];
  readonly productionStatusActionPort: DeadlineUnitOfWork['productionStatusActionPort'];

  constructor(tx: TransactionClient) {
    this.deadlines = new PgDeadlineRepository(tx);
    this.statusActionPort = {
      async changeOrderStatusFromDeadline(command) {
        const result = await changeOrderStatusFromDeadlineInTransaction(tx, command);
        return {
          status: result.status,
          skipReason: result.skipReason ?? null,
          result: { ...result.response },
        };
      },
    };
    this.productionStatusActionPort = {
      async changeProductionStatusFromDeadline(command) {
        const result = await changeProductionStatusFromDeadlineInTransaction(tx, command);
        return {
          status: result.status,
          skipReason: result.skipReason ?? null,
          result: { ...result.response },
        };
      },
    };
  }
}
