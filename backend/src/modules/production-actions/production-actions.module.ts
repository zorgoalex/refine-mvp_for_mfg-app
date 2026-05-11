import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { DatabaseService } from '../../database/database.service';
import { PgProductionActionRepository } from './adapters/pg-production-action-repository';
import { UnavailableProductionActionRepository } from './adapters/unavailable-production-action-repository';
import { ProductionActionService } from './application/production-action.service';
import { ProductionActionsRuntimeConfigService } from './http/production-actions-runtime-config.service';
import { ProductionActionsController } from './http/production-actions.controller';

@Module({
  imports: [DatabaseModule],
  controllers: [ProductionActionsController],
  providers: [
    ProductionActionsRuntimeConfigService,
    {
      provide: ProductionActionService,
      useFactory: (database: DatabaseService) =>
        new ProductionActionService({
          productionActions: database.isConfigured
            ? new PgProductionActionRepository(database)
            : new UnavailableProductionActionRepository(),
        }),
      inject: [DatabaseService],
    },
  ],
})
export class ProductionActionsModule {}
