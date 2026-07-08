import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { DatabaseService } from '../../database/database.service';
import { OrdersModule } from '../orders/orders.module';
import { OrderTransactionService } from '../orders/application/order-transaction.service';
import { PgBazisRepository } from './adapters/pg-bazis-repository';
import { UnavailableBazisRepository } from './adapters/unavailable-bazis-repository';
import { BazisService } from './application/bazis.service';
import { BazisController } from './http/bazis.controller';
import { BazisRuntimeConfigService } from './http/bazis-runtime-config.service';

@Module({
  imports: [DatabaseModule, OrdersModule],
  controllers: [BazisController],
  providers: [
    BazisRuntimeConfigService,
    {
      provide: BazisService,
      useFactory: (database: DatabaseService, orderTransactions: OrderTransactionService) =>
        new BazisService({
          repository: database.isConfigured
            ? new PgBazisRepository(database, orderTransactions)
            : new UnavailableBazisRepository(),
          auditDatabase: database.isConfigured ? database : undefined,
        }),
      inject: [DatabaseService, OrderTransactionService],
    },
  ],
  exports: [BazisRuntimeConfigService, BazisService],
})
export class BazisModule {}
