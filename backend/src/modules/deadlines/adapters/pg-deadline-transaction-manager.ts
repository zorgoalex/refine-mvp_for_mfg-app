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
import { PgProjectNotificationRecipientRepository } from '../../projects/notifications/project-notification-recipient.repository';
import { PgProjectNotificationRepository } from '../../projects/notifications/project-notification.repository';
import { ProjectNotificationService } from '../../projects/notifications/project-notification.service';
import { PgDeadlineRepository } from './pg-deadline-repository';
import { PgProjectDeadlineOverdueNotificationPort } from './pg-project-deadline-overdue-notification-port';

export class PgDeadlineTransactionManager implements DeadlineTransactionManagerPort {
  constructor(
    private readonly database: DatabaseService,
    private readonly projectP8NotificationsEnabled: boolean = false,
  ) {}

  runInTransaction<T>(handler: (unitOfWork: DeadlineUnitOfWork) => Promise<T>): Promise<T> {
    return this.database.transaction((tx) =>
      handler(new PgDeadlineUnitOfWork(tx, this.projectP8NotificationsEnabled)));
  }
}

class PgDeadlineUnitOfWork implements DeadlineUnitOfWork {
  readonly deadlines: PgDeadlineRepository;
  readonly statusActionPort: DeadlineUnitOfWork['statusActionPort'];
  readonly productionStatusActionPort: DeadlineUnitOfWork['productionStatusActionPort'];
  readonly projectDeadlineOverduePort: DeadlineUnitOfWork['projectDeadlineOverduePort'];

  constructor(tx: TransactionClient, projectP8NotificationsEnabled: boolean) {
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
    this.projectDeadlineOverduePort = new PgProjectDeadlineOverdueNotificationPort(
      tx,
      new ProjectNotificationService({
        recipients: new PgProjectNotificationRecipientRepository(tx),
        notifications: new PgProjectNotificationRepository(tx),
      }),
      projectP8NotificationsEnabled,
    );
  }
}
