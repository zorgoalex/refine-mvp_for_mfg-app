import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { DatabaseService } from '../../database/database.service';
import { PgBazisCutRepository } from './adapters/pg-bazis-cut-repository';
import { BazisCutService } from './application/bazis-cut.service';
import { BazisCutRuntimeConfigService } from './http/bazis-cut-runtime-config.service';
import { BazisCutSetsController } from './http/bazis-cut-sets.controller';
import { ExportTemplatesModule } from '../export-templates/export-templates.module';
import { ExportTemplatesService } from '../export-templates/application/export-templates.service';

@Module({
  imports: [DatabaseModule, ExportTemplatesModule],
  controllers: [BazisCutSetsController],
  providers: [
    BazisCutRuntimeConfigService,
    {
      provide: BazisCutService,
      useFactory: (database: DatabaseService, exportTemplates: ExportTemplatesService) =>
        new BazisCutService(new PgBazisCutRepository(database, exportTemplates), undefined, database),
      inject: [DatabaseService, ExportTemplatesService],
    },
  ],
})
export class BazisCutModule {}
