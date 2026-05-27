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
import { DeadlineWorkerSchedulerService } from './application/deadline-worker-scheduler.service';
import { DeadlineWorkerService } from './application/deadline-worker.service';
import { PgProductionActionRepository } from '../production-actions/adapters/pg-production-action-repository';
import { UnavailableProductionActionRepository } from '../production-actions/adapters/unavailable-production-action-repository';
import { DeadlinePoliciesController } from './http/deadline-policies.controller';
import { DeadlineRulesController } from './http/deadline-rules.controller';
import { DeadlineSettingsController } from './http/deadline-settings.controller';
import { DeadlineWorkerController } from './http/deadline-worker.controller';
import { DeadlinesController } from './http/deadlines.controller';
import { DeadlinesRuntimeConfigService } from './http/deadlines-runtime-config.service';

@Module({
  imports: [DatabaseModule],
  controllers: [
    DeadlinesController,
    DeadlinePoliciesController,
    DeadlineRulesController,
    DeadlineSettingsController,
    DeadlineWorkerController,
  ],
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
          statusActionPort: {
            async changeOrderStatusFromDeadline(command) {
              const result = await (database.isConfigured
                ? new PgProductionActionRepository(database)
                : new UnavailableProductionActionRepository()
              ).changeOrderStatusFromDeadline(command);
              return {
                status: result.status,
                skipReason: result.skipReason ?? null,
                result: { ...result.response },
              };
            },
          },
          productionStatusActionPort: {
            async changeProductionStatusFromDeadline(command) {
              const result = await (database.isConfigured
                ? new PgProductionActionRepository(database)
                : new UnavailableProductionActionRepository()
              ).changeProductionStatusFromDeadline(command);
              return {
                status: result.status,
                skipReason: result.skipReason ?? null,
                result: { ...result.response },
              };
            },
          },
        }),
      inject: [DatabaseService],
    },
    {
      provide: DeadlineWorkerSchedulerService,
      useFactory: (
        worker: DeadlineWorkerService,
        runtimeConfig: DeadlinesRuntimeConfigService,
      ) => new DeadlineWorkerSchedulerService(worker, runtimeConfig),
      inject: [DeadlineWorkerService, DeadlinesRuntimeConfigService],
    },
  ],
})
export class DeadlinesModule {}
