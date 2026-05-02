import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { DatabaseService } from '../../database/database.service';
import { PgDeadlineNotificationPort } from './adapters/pg-deadline-notification-port';
import { PgDeadlineRepository } from './adapters/pg-deadline-repository';
import { PgDeadlineTargetResolver } from './adapters/pg-deadline-target-resolver';
import { PgDeadlineTransactionManager } from './adapters/pg-deadline-transaction-manager';
import { UnavailableDeadlineNotificationPort } from './adapters/unavailable-deadline-notification-port';
import { UnavailableDeadlineRepository } from './adapters/unavailable-deadline-repository';
import { UnavailableDeadlineTargetResolver } from './adapters/unavailable-deadline-target-resolver';
import { UnavailableDeadlineTransactionManager } from './adapters/unavailable-deadline-transaction-manager';
import { DeadlineActionDispatcherService } from './application/deadline-action-dispatcher.service';
import { DeadlineCommandService } from './application/deadline-command.service';
import { DeadlineQueryService } from './application/deadline-query.service';
import { DeadlineWorkerService } from './application/deadline-worker.service';
import { DeadlinePoliciesController } from './http/deadline-policies.controller';
import { DeadlineSettingsController } from './http/deadline-settings.controller';
import { DeadlinesController } from './http/deadlines.controller';
import { DeadlinesRuntimeConfigService } from './http/deadlines-runtime-config.service';

@Module({
  imports: [DatabaseModule],
  controllers: [DeadlinesController, DeadlinePoliciesController, DeadlineSettingsController],
  providers: [
    DeadlinesRuntimeConfigService,
    DeadlineActionDispatcherService,
    {
      provide: DeadlineQueryService,
      useFactory: (database: DatabaseService) =>
        new DeadlineQueryService({
          repository: database.isConfigured
            ? new PgDeadlineRepository(database)
            : new UnavailableDeadlineRepository(),
        }),
      inject: [DatabaseService],
    },
    {
      provide: DeadlineCommandService,
      useFactory: (database: DatabaseService) =>
        new DeadlineCommandService({
          transactions: database.isConfigured
            ? new PgDeadlineTransactionManager(database)
            : new UnavailableDeadlineTransactionManager(),
        }),
      inject: [DatabaseService],
    },
    {
      provide: DeadlineWorkerService,
      useFactory: (database: DatabaseService) =>
        new DeadlineWorkerService({
          transactions: database.isConfigured
            ? new PgDeadlineTransactionManager(database)
            : new UnavailableDeadlineTransactionManager(),
          targetResolver: database.isConfigured
            ? new PgDeadlineTargetResolver(database)
            : new UnavailableDeadlineTargetResolver(),
          notificationPort: database.isConfigured
            ? new PgDeadlineNotificationPort(database)
            : new UnavailableDeadlineNotificationPort(),
        }),
      inject: [DatabaseService],
    },
  ],
})
export class DeadlinesModule {}
