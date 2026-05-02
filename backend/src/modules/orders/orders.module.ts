import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseModule } from '../../database/database.module';
import { DatabaseService } from '../../database/database.service';
import type { BackendEnv } from '../../config/env.validation';
import { PgOrderDeadlineSync } from '../deadlines/adapters/pg-order-deadline-sync';
import { PgOrderReadRepository } from './adapters/pg-order-read-repository';
import { PgOrderTransactionManager } from './adapters/pg-order-transaction-manager';
import { UnavailableOrderExporter } from './adapters/unavailable-order-exporter';
import { UnavailableOrderReadRepository } from './adapters/unavailable-order-read-repository';
import { OrderExportService } from './application/order-export.service';
import { OrderTransactionService } from './application/order-transaction.service';
import { OrderQueryService } from './application/order-query.service';
import { UnavailableOrderTransactionManager } from './adapters/unavailable-order-transaction-manager';
import { OrderExportController } from './http/order-export.controller';
import { OrdersController } from './http/orders.controller';
import { OrdersRuntimeConfigService } from './http/orders-runtime-config.service';

@Module({
  imports: [DatabaseModule],
  controllers: [OrdersController, OrderExportController],
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
      useFactory: () =>
        new OrderExportService({
          exporter: new UnavailableOrderExporter(),
        }),
    },
  ],
})
export class OrdersModule {}
