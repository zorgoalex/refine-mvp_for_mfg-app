import { Module } from '@nestjs/common';
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
  controllers: [DeadlinesController, DeadlinePoliciesController, DeadlineSettingsController],
  providers: [
    DeadlinesRuntimeConfigService,
    DeadlineActionDispatcherService,
    {
      provide: DeadlineQueryService,
      useFactory: () =>
        new DeadlineQueryService({
          repository: new UnavailableDeadlineRepository(),
        }),
    },
    {
      provide: DeadlineCommandService,
      useFactory: () =>
        new DeadlineCommandService({
          transactions: new UnavailableDeadlineTransactionManager(),
        }),
    },
    {
      provide: DeadlineWorkerService,
      useFactory: () =>
        new DeadlineWorkerService({
          transactions: new UnavailableDeadlineTransactionManager(),
          targetResolver: new UnavailableDeadlineTargetResolver(),
          notificationPort: new UnavailableDeadlineNotificationPort(),
        }),
    },
  ],
})
export class DeadlinesModule {}
