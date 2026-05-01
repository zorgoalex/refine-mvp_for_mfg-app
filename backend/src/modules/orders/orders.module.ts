import { Module } from '@nestjs/common';
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
  controllers: [OrdersController, OrderExportController],
  providers: [
    OrdersRuntimeConfigService,
    {
      provide: OrderTransactionService,
      useFactory: () =>
        new OrderTransactionService({
          transactions: new UnavailableOrderTransactionManager(),
        }),
    },
    {
      provide: OrderQueryService,
      useFactory: () =>
        new OrderQueryService({
          reader: new UnavailableOrderReadRepository(),
        }),
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
