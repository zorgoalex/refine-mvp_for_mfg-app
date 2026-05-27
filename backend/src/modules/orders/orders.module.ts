import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseModule } from '../../database/database.module';
import { DatabaseService } from '../../database/database.service';
import type { BackendEnv } from '../../config/env.validation';
import { PgOrderDeadlineSync } from '../deadlines/adapters/pg-order-deadline-sync';
import { ProjectsRuntimeConfigService } from '../projects/projects-runtime-config.service';
import { PgOrderExporter } from './adapters/pg-order-exporter';
import { PgOrderReadRepository } from './adapters/pg-order-read-repository';
import { PgOrderSnapshot } from './adapters/pg-order-snapshot';
import { PgOrderProjectLinkRepository, UnavailableOrderProjectLinkRepository } from './adapters/pg-order-project-link-repository';
import { PgOrderTransactionManager } from './adapters/pg-order-transaction-manager';
import { UnavailableOrderExporter } from './adapters/unavailable-order-exporter';
import { UnavailableOrderReadRepository } from './adapters/unavailable-order-read-repository';
import { UnavailableOrderSnapshot } from './adapters/unavailable-order-snapshot';
import { OrderExportService } from './application/order-export.service';
import { OrderProjectLinkService } from './application/order-project-link.service';
import { OrderSnapshotService } from './application/order-snapshot.service';
import { OrderTransactionService } from './application/order-transaction.service';
import { OrderQueryService } from './application/order-query.service';
import { RateLimitService } from '../../rate-limit/rate-limit.service';
import { UnavailableOrderTransactionManager } from './adapters/unavailable-order-transaction-manager';
import { SharedOrderExportRateLimiter } from './application/order-export-rate-limiter';
import { OrderExportController } from './http/order-export.controller';
import { OrderProjectLinksController } from './http/order-project-links.controller';
import { OrderSnapshotController } from './http/order-snapshot.controller';
import { OrdersController } from './http/orders.controller';
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
  controllers: [OrdersController, OrderExportController, OrderSnapshotController, OrderProjectLinksController],
  providers: [
    OrdersRuntimeConfigService,
    ProjectsRuntimeConfigService,
    {
      provide: OrderTransactionService,
      useFactory: (database: DatabaseService, config: ConfigService<BackendEnv, true>) =>
        new OrderTransactionService({
          transactions: database.isConfigured
            ? new PgOrderTransactionManager(database)
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
        }),
      inject: [DatabaseService, ConfigService],
    },
    {
      provide: OrderQueryService,
      useFactory: (database: DatabaseService) =>
        new OrderQueryService({
          reader: database.isConfigured
            ? new PgOrderReadRepository(database)
            : new UnavailableOrderReadRepository(),
        }),
      inject: [DatabaseService],
    },
    {
      provide: OrderProjectLinkService,
      useFactory: (database: DatabaseService) =>
        new OrderProjectLinkService({
          links: database.isConfigured
            ? new PgOrderProjectLinkRepository(database)
            : new UnavailableOrderProjectLinkRepository(),
        }),
      inject: [DatabaseService],
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
})
export class OrdersModule {}
