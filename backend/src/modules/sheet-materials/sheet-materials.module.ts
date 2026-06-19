import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { DatabaseService } from '../../database/database.service';
import { PgSheetMaterialsRepository } from './adapters/pg-sheet-materials-repository';
import { UnavailableSheetMaterialsRepository } from './adapters/unavailable-sheet-materials-repository';
import { SheetMaterialsService } from './application/sheet-materials.service';
import { SheetMaterialsRuntimeConfigService } from './http/sheet-materials-runtime-config.service';
import { SheetMaterialsController } from './http/sheet-materials.controller';

@Module({
  imports: [DatabaseModule],
  controllers: [SheetMaterialsController],
  providers: [
    SheetMaterialsRuntimeConfigService,
    {
      provide: SheetMaterialsService,
      useFactory: (database: DatabaseService) =>
        new SheetMaterialsService({
          repo: database.isConfigured
            ? new PgSheetMaterialsRepository(database)
            : new UnavailableSheetMaterialsRepository(),
        }),
      inject: [DatabaseService],
    },
  ],
})
export class SheetMaterialsModule {}
