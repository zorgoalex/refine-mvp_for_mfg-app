import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseModule } from '../../database/database.module';
import { DatabaseService } from '../../database/database.service';
import { OrdersModule } from '../orders/orders.module';
import { OrderTransactionService } from '../orders/application/order-transaction.service';
import { PgBazisRepository } from './adapters/pg-bazis-repository';
import { UnavailableBazisRepository } from './adapters/unavailable-bazis-repository';
import { BazisService } from './application/bazis.service';
import { BazisController } from './http/bazis.controller';
import { BazisRuntimeConfigService } from './http/bazis-runtime-config.service';
import { PdfTablePatternsModule } from './pdf-table-patterns/pdf-table-patterns.controller';

@Module({
  imports: [DatabaseModule, OrdersModule, PdfTablePatternsModule],
  controllers: [BazisController],
  providers: [
    BazisRuntimeConfigService,
    {
      provide: BazisService,
      useFactory: (
        database: DatabaseService,
        orderTransactions: OrderTransactionService,
        config: ConfigService,
      ) =>
        new BazisService({
          repository: database.isConfigured
            ? new PgBazisRepository(
                database,
                orderTransactions,
                config.get('BACKEND_SHEET_ORDERS_READS') ?? true,
              )
            : new UnavailableBazisRepository(),
          auditDatabase: database.isConfigured ? database : undefined,
        }),
      inject: [DatabaseService, OrderTransactionService, ConfigService],
    },
  ],
  exports: [BazisRuntimeConfigService, BazisService],
})
export class BazisModule {}
