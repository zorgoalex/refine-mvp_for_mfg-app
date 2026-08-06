import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseModule } from '../../database/database.module';
import { DatabaseService } from '../../database/database.service';
import type { BackendEnv } from '../../config/env.validation';
import { PgOrderDeadlineSync } from '../deadlines/adapters/pg-order-deadline-sync';
import { PgDeadlineDefaultScheduleRepository } from '../deadlines/adapters/pg-deadline-default-schedule-repository';
import {
  PgGroupNotificationRecipientRepository,
  UnavailableGroupNotificationRecipientRepository,
} from '../groups/notifications/group-notification-recipient.repository';
import {
  PgGroupNotificationRepository,
  UnavailableGroupNotificationRepository,
} from '../groups/notifications/group-notification.repository';
import { GroupNotificationService } from '../groups/notifications/group-notification.service';
import { GroupsRuntimeConfigService } from '../groups/groups-runtime-config.service';
import { PgOrderExporter } from './adapters/pg-order-exporter';
import { PgOrderReadRepository } from './adapters/pg-order-read-repository';
import { PgOrderResourceDemandRepository } from './adapters/pg-order-resource-demand-repository';
import { PgOrderStatusBoardRepository } from './adapters/pg-order-status-board-repository';
import { PgOrderSnapshot } from './adapters/pg-order-snapshot';
import { PgOrderGroupLinkRepository, UnavailableOrderGroupLinkRepository } from './adapters/pg-order-group-link-repository';
import { PgOrderTransactionManager } from './adapters/pg-order-transaction-manager';
import { UnavailableOrderExporter } from './adapters/unavailable-order-exporter';
import { UnavailableOrderReadRepository } from './adapters/unavailable-order-read-repository';
import { UnavailableOrderStatusBoardRepository } from './adapters/unavailable-order-status-board-repository';
import { UnavailableOrderSnapshot } from './adapters/unavailable-order-snapshot';
import { OrderExportService } from './application/order-export.service';
import { OrderGroupLinkService } from './application/order-group-link.service';
import { OrderSnapshotService } from './application/order-snapshot.service';
import { OrderDetailTransferService } from './application/order-detail-transfer.service';
import { OrderTransactionService } from './application/order-transaction.service';
import { OrderQueryService } from './application/order-query.service';
import { OrderRefreshService } from './application/order-refresh.service';
import { OrderResourceDemandService } from './application/order-resource-demand.service';
import { OrderStatusBoardService } from './application/order-status-board.service';
import { RateLimitService } from '../../rate-limit/rate-limit.service';
import { UnavailableOrderTransactionManager } from './adapters/unavailable-order-transaction-manager';
import { SharedOrderExportRateLimiter } from './application/order-export-rate-limiter';
import { OrderExportController } from './http/order-export.controller';
import { OrderGroupLinksController } from './http/order-group-links.controller';
import { OrderResourceDemandController } from './http/order-resource-demand.controller';
import { OrderSnapshotController } from './http/order-snapshot.controller';
import { OrdersController } from './http/orders.controller';
import { OrderStatusBoardController } from './http/order-status-board.controller';
import { OrdersRuntimeConfigService } from './http/orders-runtime-config.service';

export function shouldEnableOrderDeadlineSync(input: {
  databaseConfigured: boolean;
  deadlinesEnabled: boolean;
  deadlinesReadOnly: boolean;
  orderSyncEnabled: boolean;
}): boolean {
  return (
    input.databaseConfigured &&
    input.deadlinesEnabled &&
    !input.deadlinesReadOnly &&
    input.orderSyncEnabled
  );
}

@Module({
  imports: [DatabaseModule],
  controllers: [
    // Register static `/orders/*` routes before the generic `/orders/:orderId`.
    OrderStatusBoardController,
    OrderExportController,
    OrderSnapshotController,
    OrderGroupLinksController,
    OrderResourceDemandController,
    OrdersController,
  ],
  providers: [
    OrdersRuntimeConfigService,
    GroupsRuntimeConfigService,
    {
      provide: OrderTransactionService,
      useFactory: (database: DatabaseService, config: ConfigService<BackendEnv, true>) =>
        new OrderTransactionService({
          transactions: database.isConfigured
            ? new PgOrderTransactionManager(
                database,
                config.get('BACKEND_SHEET_ORDERS_READS', { infer: true }),
              )
            : new UnavailableOrderTransactionManager(),
          deadlineSync:
            shouldEnableOrderDeadlineSync({
              databaseConfigured: database.isConfigured,
              deadlinesEnabled: config.get('BACKEND_ENABLE_DEADLINES', { infer: true }),
              deadlinesReadOnly: config.get('BACKEND_DEADLINES_READ_ONLY', { infer: true }),
              orderSyncEnabled: config.get('BACKEND_ENABLE_DEADLINE_ORDER_SYNC', { infer: true }),
            })
              ? new PgOrderDeadlineSync(database)
              : undefined,
          defaultSchedule:
            database.isConfigured &&
            config.get('BACKEND_ENABLE_DEADLINES', { infer: true })
            ? {
                async getConfiguredSchedule(client) {
                  const schedule = await new PgDeadlineDefaultScheduleRepository(
                    database,
                  ).getSchedule(client);
                  if (!schedule.configured) {
                    return null;
                  }
                  return {
                    version: schedule.version,
                    reserveDays: schedule.reserveDays,
                    transitionsOrder: schedule.transitionsOrder,
                    stages: schedule.stages.flatMap((stage) =>
                      stage.durationDays === null
                        ? []
                        : [
                            {
                              productionStatusId: stage.productionStatusId,
                              productionStatusCode: stage.productionStatusCode,
                              durationDays: stage.durationDays,
                              parallelWithPrevious: stage.parallelWithPrevious,
                            },
                          ],
                    ),
                  };
                },
              }
            : undefined,
        }),
      inject: [DatabaseService, ConfigService],
    },
    {
      provide: OrderQueryService,
      useFactory: (database: DatabaseService, config: ConfigService<BackendEnv, true>) =>
        new OrderQueryService({
          reader: database.isConfigured
            ? new PgOrderReadRepository(
                database,
                config.get('BACKEND_SHEET_ORDERS_READS', { infer: true }),
              )
            : new UnavailableOrderReadRepository(),
        }),
      inject: [DatabaseService, ConfigService],
    },
    {
      provide: OrderDetailTransferService,
      useFactory: (database: DatabaseService, config: ConfigService<BackendEnv, true>) =>
        new OrderDetailTransferService({
          database,
          sheetOrdersReads: config.get('BACKEND_SHEET_ORDERS_READS', { infer: true }),
          deadlineSync:
            shouldEnableOrderDeadlineSync({
              databaseConfigured: database.isConfigured,
              deadlinesEnabled: config.get('BACKEND_ENABLE_DEADLINES', { infer: true }),
              deadlinesReadOnly: config.get('BACKEND_DEADLINES_READ_ONLY', { infer: true }),
              orderSyncEnabled: config.get('BACKEND_ENABLE_DEADLINE_ORDER_SYNC', { infer: true }),
            })
              ? new PgOrderDeadlineSync(database)
              : undefined,
        }),
      inject: [DatabaseService, ConfigService],
    },
    {
      provide: OrderRefreshService,
      useFactory: (database: DatabaseService) => new OrderRefreshService({ database }),
      inject: [DatabaseService],
    },
    {
      provide: OrderResourceDemandService,
      useFactory: (database: DatabaseService) =>
        new OrderResourceDemandService({
          demands: new PgOrderResourceDemandRepository(database),
        }),
      inject: [DatabaseService],
    },
    {
      provide: OrderStatusBoardService,
      useFactory: (database: DatabaseService) =>
        new OrderStatusBoardService({
          boards: database.isConfigured
            ? new PgOrderStatusBoardRepository(database)
            : new UnavailableOrderStatusBoardRepository(),
        }),
      inject: [DatabaseService],
    },
    {
      provide: OrderGroupLinkService,
      useFactory: (
        database: DatabaseService,
        groupNotifications: GroupNotificationService,
        groupsRuntimeConfig: GroupsRuntimeConfigService,
      ) =>
        new OrderGroupLinkService({
          links: database.isConfigured
            ? new PgOrderGroupLinkRepository(database)
            : new UnavailableOrderGroupLinkRepository(),
          groupNotifications,
          groupP8NotificationsEnabled: groupsRuntimeConfig.getFeatureFlags().groupP8NotificationsEnabled,
        }),
      inject: [DatabaseService, GroupNotificationService, GroupsRuntimeConfigService],
    },
    {
      provide: PgGroupNotificationRecipientRepository,
      useFactory: (database: DatabaseService) =>
        database.isConfigured
          ? new PgGroupNotificationRecipientRepository(database)
          : new UnavailableGroupNotificationRecipientRepository(),
      inject: [DatabaseService],
    },
    {
      provide: PgGroupNotificationRepository,
      useFactory: (database: DatabaseService) =>
        database.isConfigured
          ? new PgGroupNotificationRepository(database)
          : new UnavailableGroupNotificationRepository(),
      inject: [DatabaseService],
    },
    {
      provide: GroupNotificationService,
      useFactory: (
        recipients: PgGroupNotificationRecipientRepository,
        notifications: PgGroupNotificationRepository,
      ) =>
        new GroupNotificationService({
          recipients,
          notifications,
        }),
      inject: [PgGroupNotificationRecipientRepository, PgGroupNotificationRepository],
    },
    {
      provide: OrderExportService,
      useFactory: (
        database: DatabaseService,
        config: ConfigService<BackendEnv, true>,
        rateLimits: RateLimitService,
      ) =>
        new OrderExportService({
          exporter:
            database.isConfigured &&
            config.get('GAS_WEBAPP_URL', { infer: true }) &&
            config.get('GAS_API_KEY', { infer: true })
              ? new PgOrderExporter(database, {
                  gasWebappUrl: config.get('GAS_WEBAPP_URL', { infer: true }) ?? '',
                  gasApiKey: config.get('GAS_API_KEY', { infer: true }) ?? '',
                  timeoutMs: config.get('GAS_EXPORT_TIMEOUT_MS', { infer: true }),
                })
              : new UnavailableOrderExporter(),
          rateLimiter: new SharedOrderExportRateLimiter(rateLimits),
        }),
      inject: [DatabaseService, ConfigService, RateLimitService],
    },
    {
      provide: OrderSnapshotService,
      useFactory: (database: DatabaseService) =>
        new OrderSnapshotService({
          snapshots: database.isConfigured
            ? new PgOrderSnapshot(database)
            : new UnavailableOrderSnapshot(),
        }),
      inject: [DatabaseService],
    },
  ],
  exports: [OrderTransactionService],
})
export class OrdersModule {}
