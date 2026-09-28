import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { OnecAgentModule } from '../onec-agent/onec-agent.module';
import { CatalogImportService } from './application/catalog-import.service';
import { CatalogImportRuntimeConfigService } from './application/catalog-import-runtime-config.service';
import {
  CatalogImportController,
  FilmReferenceController,
} from './http/catalog-import.controller';
@Module({
  imports: [DatabaseModule, OnecAgentModule],
  controllers: [CatalogImportController, FilmReferenceController],
  providers: [CatalogImportService, CatalogImportRuntimeConfigService],
  exports: [CatalogImportService],
})
export class ReferenceCatalogImportModule {}
