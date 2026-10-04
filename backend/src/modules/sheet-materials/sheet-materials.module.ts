import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { DatabaseService } from '../../database/database.service';
import { ApiError } from '../../common/errors/api-error';
import { OnecAgentModule } from '../onec-agent/onec-agent.module';
import { OnecCatalogReader } from '../onec-agent/onec-catalog-reader';
import { PgSheetMaterialsRepository } from './adapters/pg-sheet-materials-repository';
import { UnavailableSheetMaterialsRepository } from './adapters/unavailable-sheet-materials-repository';
import { SheetMaterialsService } from './application/sheet-materials.service';
import { SheetMaterialsRuntimeConfigService } from './http/sheet-materials-runtime-config.service';
import { SheetMaterialsController } from './http/sheet-materials.controller';

@Module({
  imports: [DatabaseModule, OnecAgentModule],
  controllers: [SheetMaterialsController],
  providers: [
    SheetMaterialsRuntimeConfigService,
    {
      provide: SheetMaterialsService,
      useFactory: (database: DatabaseService, onec: OnecCatalogReader) =>
        new SheetMaterialsService({
          repo: database.isConfigured
            ? new PgSheetMaterialsRepository(database)
            : new UnavailableSheetMaterialsRepository(),
          // Копия данных 1С недоступна (модуль выключен, таблиц нет) — выбора нет, ключ вводится вручную.
          onecItems: async () => {
            try {
              return await onec.listAllItems();
            } catch (error) {
              if (error instanceof ApiError && error.code === 'ONEC_MIRROR_UNAVAILABLE') return null;
              throw error;
            }
          },
        }),
      inject: [DatabaseService, OnecCatalogReader],
    },
  ],
})
export class SheetMaterialsModule {}
