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
import { PgGroupNotificationRecipientRepository } from '../../groups/notifications/group-notification-recipient.repository';
import { PgGroupNotificationRepository } from '../../groups/notifications/group-notification.repository';
import { GroupNotificationService } from '../../groups/notifications/group-notification.service';
import { PgDeadlineRepository } from './pg-deadline-repository';
import { PgGroupDeadlineOverdueNotificationPort } from './pg-group-deadline-overdue-notification-port';

export class PgDeadlineTransactionManager implements DeadlineTransactionManagerPort {
  constructor(
    private readonly database: DatabaseService,
    private readonly groupP8NotificationsEnabled: boolean = false,
  ) {}

  runInTransaction<T>(handler: (unitOfWork: DeadlineUnitOfWork) => Promise<T>): Promise<T> {
    return this.database.transaction((tx) =>
      handler(new PgDeadlineUnitOfWork(tx, this.groupP8NotificationsEnabled)));
  }
}

class PgDeadlineUnitOfWork implements DeadlineUnitOfWork {
  readonly deadlines: PgDeadlineRepository;
  readonly statusActionPort: DeadlineUnitOfWork['statusActionPort'];
  readonly productionStatusActionPort: DeadlineUnitOfWork['productionStatusActionPort'];
  readonly groupDeadlineOverduePort: DeadlineUnitOfWork['groupDeadlineOverduePort'];

  constructor(tx: TransactionClient, groupP8NotificationsEnabled: boolean) {
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
    this.groupDeadlineOverduePort = new PgGroupDeadlineOverdueNotificationPort(
      tx,
      new GroupNotificationService({
        recipients: new PgGroupNotificationRecipientRepository(tx),
        notifications: new PgGroupNotificationRepository(tx),
      }),
      groupP8NotificationsEnabled,
    );
  }
}
