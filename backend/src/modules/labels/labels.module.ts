import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { DatabaseService } from '../../database/database.service';
import { PgLabelsRepository } from './adapters/pg-labels-repository';
import { UnavailableLabelsRepository } from './adapters/unavailable-labels-repository';
import { LabelsService } from './application/labels.service';
import { LabelFieldsController } from './http/label-fields.controller';
import { LabelQrTemplatesController } from './http/label-qr-templates.controller';
import { LabelTemplatesController } from './http/label-templates.controller';
import { DetailLabelActionsController, OrderLabelActionsController, OrderLabelsController } from './http/order-labels.controller';
import { LabelsRuntimeConfigService } from './http/labels-runtime-config.service';

@Module({
  imports: [DatabaseModule],
  controllers: [
    LabelFieldsController,
    LabelTemplatesController,
    LabelQrTemplatesController,
    OrderLabelsController,
    OrderLabelActionsController,
    DetailLabelActionsController,
  ],
  providers: [
    LabelsRuntimeConfigService,
    {
      provide: LabelsService,
      useFactory: (database: DatabaseService) =>
        new LabelsService({
          repo: database.isConfigured ? new PgLabelsRepository(database) : new UnavailableLabelsRepository(),
        }),
      inject: [DatabaseService],
    },
  ],
})
export class LabelsModule {}
