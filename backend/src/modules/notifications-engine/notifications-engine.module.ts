import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { DatabaseService } from '../../database/database.service';
import { PgNotificationRuleRepository } from './adapters/pg-notification-rule-repository';
import { PgRecipientSourceAdapter } from './adapters/pg-recipient-source';
import { PgVisibilityAdapter } from './adapters/pg-visibility';
import { PgNotificationWriteAdapter } from './adapters/pg-notification-write';
import { PgNotificationContextBuilder } from './adapters/pg-notification-context';
import { PgOutboxRepository } from './adapters/pg-outbox-repository';
import { NotificationRulesService } from './application/notification-rules.service';
import { RecipientResolverService } from './application/recipient-resolver.service';
import { NotificationRuleEngineService } from './application/notification-rule-engine.service';
import { OutboxRelayService, type OutboxConsumer } from './application/outbox-relay.service';
import { OutboxRelaySchedulerService } from './application/outbox-relay-scheduler.service';
import { isEngineOwnedEvent } from './domain/notification-event-registry';
import { NotificationRulesController } from './http/notification-rules.controller';
import { NotificationsRuntimeConfigService } from './http/notifications-runtime-config.service';
import { OutboxRelayController } from './http/outbox-relay.controller';

@Module({
  imports: [DatabaseModule],
  controllers: [NotificationRulesController, OutboxRelayController],
  providers: [
    NotificationsRuntimeConfigService,
    {
      provide: NotificationRulesService,
      useFactory: (database: DatabaseService) =>
        new NotificationRulesService({
          repository: new PgNotificationRuleRepository(),
          database,
        }),
      inject: [DatabaseService],
    },
    {
      provide: NotificationRuleEngineService,
      useFactory: (runtimeConfig: NotificationsRuntimeConfigService) =>
        new NotificationRuleEngineService({
          ruleRepo: new PgNotificationRuleRepository(),
          contextBuilder: new PgNotificationContextBuilder(),
          recipientResolver: new RecipientResolverService(
            new PgRecipientSourceAdapter(),
            new PgVisibilityAdapter(),
          ),
          notificationWrite: new PgNotificationWriteAdapter(),
          runtimeConfig,
        }),
      inject: [NotificationsRuntimeConfigService],
    },
    {
      provide: OutboxRelayService,
      useFactory: (
        database: DatabaseService,
        runtimeConfig: NotificationsRuntimeConfigService,
        engine: NotificationRuleEngineService,
      ) => {
        const flags = runtimeConfig.getFeatureFlags();
        const engineConsumer: OutboxConsumer = {
          supports: (eventType) => {
            if (isEngineOwnedEvent(eventType)) return true;
            // The deadline worker enqueues a single envelope event_type for
            // every terminal type. The engine resolves the inner type at
            // consumption time. When the convergence flag is on, the relay
            // hands the envelope to the engine so the engine can dispatch
            // the inner event. When the flag is off, the envelope is left
            // for the legacy inline dispatcher (no double-send).
            return eventType === 'deadline.event.created' && flags.engineOwnsDeadline;
          },
          process: async (client, event) => {
            await engine.processEvent(client, event);
          },
        };
        return new OutboxRelayService({
          database,
          outboxRepo: new PgOutboxRepository(),
          consumers: [engineConsumer],
          config: {
            workerId: flags.relayWorkerId,
            batchSize: flags.relayBatchSize,
            maxAttempts: flags.relayMaxAttempts,
          },
        });
      },
      inject: [DatabaseService, NotificationsRuntimeConfigService, NotificationRuleEngineService],
    },
    {
      provide: OutboxRelaySchedulerService,
      useFactory: (relay: OutboxRelayService, runtimeConfig: NotificationsRuntimeConfigService) =>
        new OutboxRelaySchedulerService(relay, runtimeConfig),
      inject: [OutboxRelayService, NotificationsRuntimeConfigService],
    },
  ],
})
export class NotificationsEngineModule {}
