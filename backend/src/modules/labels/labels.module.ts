import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BackendEnv } from '../../config/env.validation';
import { DatabaseModule } from '../../database/database.module';
import { DatabaseService } from '../../database/database.service';
import { PgLabelsRepository } from './adapters/pg-labels-repository';
import { UnavailableLabelsRepository } from './adapters/unavailable-labels-repository';
import { createOcrClientFromEnv } from './adapters/http-ocr-client';
import { LabelsService } from './application/labels.service';
import { LabelFieldsController } from './http/label-fields.controller';
import { LabelOcrTemplatesController } from './http/label-ocr-templates.controller';
import { LabelQrTemplatesController } from './http/label-qr-templates.controller';
import { LabelScanController } from './http/label-scan.controller';
import { LabelTemplatesController } from './http/label-templates.controller';
import { DetailLabelActionsController, OrderLabelActionsController, OrderLabelsController } from './http/order-labels.controller';
import { LabelsRuntimeConfigService } from './http/labels-runtime-config.service';

@Module({
  imports: [DatabaseModule],
  controllers: [
    LabelFieldsController,
    LabelTemplatesController,
    LabelQrTemplatesController,
    LabelOcrTemplatesController,
    LabelScanController,
    OrderLabelsController,
    OrderLabelActionsController,
    DetailLabelActionsController,
  ],
  providers: [
    LabelsRuntimeConfigService,
    {
      provide: LabelsService,
      useFactory: (database: DatabaseService, config: ConfigService<BackendEnv, true>) =>
        new LabelsService({
          repo: database.isConfigured
            ? new PgLabelsRepository(database, {
              telegramMediaDir: config.get('CNC_TELEGRAM_MEDIA_DIR', { infer: true }),
              telegramFallbackEnabled: config.get('LABEL_TELEGRAM_CUT_MAP_FALLBACK_ENABLED', { infer: true }),
            })
            : new UnavailableLabelsRepository(),
          ocr: createOcrClientFromEnv(config.get('OCR_SERVICE_BASE_URL', { infer: true })),
        }),
      inject: [DatabaseService, ConfigService],
    },
  ],
})
export class LabelsModule {}
