import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseModule } from '../../database/database.module';
import { DatabaseService } from '../../database/database.service';
import type { BackendEnv } from '../../config/env.validation';
import { PgOrderDeadlineSync } from '../deadlines/adapters/pg-order-deadline-sync';
import { PgOrderExporter } from './adapters/pg-order-exporter';
import { PgOrderReadRepository } from './adapters/pg-order-read-repository';
import { PgOrderSnapshot } from './adapters/pg-order-snapshot';
import { PgOrderTransactionManager } from './adapters/pg-order-transaction-manager';
import { UnavailableOrderExporter } from './adapters/unavailable-order-exporter';
import { UnavailableOrderReadRepository } from './adapters/unavailable-order-read-repository';
import { UnavailableOrderSnapshot } from './adapters/unavailable-order-snapshot';
import { OrderExportService } from './application/order-export.service';
import { OrderSnapshotService } from './application/order-snapshot.service';
import { OrderTransactionService } from './application/order-transaction.service';
import { OrderQueryService } from './application/order-query.service';
import { UnavailableOrderTransactionManager } from './adapters/unavailable-order-transaction-manager';
import { OrderExportController } from './http/order-export.controller';
import { OrderSnapshotController } from './http/order-snapshot.controller';
import { OrdersController } from './http/orders.controller';
import { OrdersRuntimeConfigService } from './http/orders-runtime-config.service';

@Module({
  imports: [DatabaseModule],
  controllers: [OrdersController, OrderExportController, OrderSnapshotController],
  providers: [
    OrdersRuntimeConfigService,
    {
      provide: OrderTransactionService,
      useFactory: (database: DatabaseService, config: ConfigService<BackendEnv, true>) =>
        new OrderTransactionService({
          transactions: database.isConfigured
            ? new PgOrderTransactionManager(database)
            : new UnavailableOrderTransactionManager(),
          deadlineSync:
            database.isConfigured && config.get('BACKEND_ENABLE_DEADLINES', { infer: true })
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
      provide: OrderExportService,
      useFactory: (database: DatabaseService, config: ConfigService<BackendEnv, true>) =>
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
        }),
      inject: [DatabaseService, ConfigService],
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
