import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { OnecAgentModule } from '../onec-agent/onec-agent.module';
import { OnecDocumentConsumers } from './application/onec-document-consumers';
import { OnecDocumentsLoaderService } from './application/onec-documents-loader.service';
import { OnecDocumentsEvents } from './application/onec-documents-events';
import { OnecDocumentsReader } from './application/onec-documents-reader';

/**
 * 1C → ERP projections (plan E4 «onec-sync»): the documents loader writes the shared 1C document layer
 * (onec_documents*) and calls consumer ports; business modules register as consumers and never the reverse.
 */
@Module({
  imports: [DatabaseModule, OnecAgentModule],
  providers: [OnecDocumentConsumers, OnecDocumentsLoaderService, OnecDocumentsReader, OnecDocumentsEvents],
  // OnecDocumentsReader / OnecDocumentsEvents — read-порт и сигнал документов расхода для проекции склада (план расхода §3.3, §3.5).
  exports: [OnecDocumentConsumers, OnecDocumentsReader, OnecDocumentsEvents],
})
export class OnecSyncModule {}
