import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { DatabaseService } from '../../database/database.service';
import { PgDeadlineNotificationPort } from './adapters/pg-deadline-notification-port';
import { PgDeadlineDefaultScheduleRepository } from './adapters/pg-deadline-default-schedule-repository';
import { PgDeadlineRepository } from './adapters/pg-deadline-repository';
import { PgDeadlineTargetResolver } from './adapters/pg-deadline-target-resolver';
import { PgDeadlineTransactionManager } from './adapters/pg-deadline-transaction-manager';
import { UnavailableDeadlineNotificationPort } from './adapters/unavailable-deadline-notification-port';
import { UnavailableDeadlineRepository } from './adapters/unavailable-deadline-repository';
import { UnavailableDeadlineTargetResolver } from './adapters/unavailable-deadline-target-resolver';
import { UnavailableDeadlineTransactionManager } from './adapters/unavailable-deadline-transaction-manager';
import { DeadlineActionDispatcherService } from './application/deadline-action-dispatcher.service';
import {
  DeadlineDefaultScheduleService,
  UnavailableDeadlineDefaultScheduleRepository,
} from './application/deadline-default-schedule.service';
import { DeadlineCommandService } from './application/deadline-command.service';
import { DeadlineQueryService } from './application/deadline-query.service';
import { DeadlineWorkerSchedulerService } from './application/deadline-worker-scheduler.service';
import { DeadlineWorkerService } from './application/deadline-worker.service';
import { PgProductionActionRepository } from '../production-actions/adapters/pg-production-action-repository';
import { UnavailableProductionActionRepository } from '../production-actions/adapters/unavailable-production-action-repository';
import { DeadlinePoliciesController } from './http/deadline-policies.controller';
import { DeadlineDefaultScheduleController } from './http/deadline-default-schedule.controller';
import { DeadlineRulesController } from './http/deadline-rules.controller';
import { DeadlineSettingsController } from './http/deadline-settings.controller';
import { DeadlineWorkerController } from './http/deadline-worker.controller';
import { DeadlinesController } from './http/deadlines.controller';
import { DeadlinesRuntimeConfigService } from './http/deadlines-runtime-config.service';
import { GroupsModule } from '../groups/groups.module';
import { GroupsRuntimeConfigService } from '../groups/groups-runtime-config.service';

@Module({
  imports: [DatabaseModule, GroupsModule],
  controllers: [
    DeadlinesController,
    DeadlinePoliciesController,
    DeadlineRulesController,
    DeadlineSettingsController,
    DeadlineDefaultScheduleController,
    DeadlineWorkerController,
  ],
  providers: [
    DeadlinesRuntimeConfigService,
    DeadlineActionDispatcherService,
    {
      provide: DeadlineDefaultScheduleService,
      useFactory: (database: DatabaseService) =>
        new DeadlineDefaultScheduleService(
          database.isConfigured
            ? new PgDeadlineDefaultScheduleRepository(database)
            : new UnavailableDeadlineDefaultScheduleRepository(),
        ),
      inject: [DatabaseService],
    },
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
      useFactory: (
        database: DatabaseService,
        groupsRuntimeConfig: GroupsRuntimeConfigService,
      ) =>
        new DeadlineWorkerService({
          transactions: database.isConfigured
            ? new PgDeadlineTransactionManager(
                database,
                groupsRuntimeConfig.getFeatureFlags().groupP8NotificationsEnabled,
              )
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
      inject: [DatabaseService, GroupsRuntimeConfigService],
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
