import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { OnecAgentModule } from '../onec-agent/onec-agent.module';
import { OnecDocumentConsumers } from './application/onec-document-consumers';
import { OnecDocumentsLoaderService } from './application/onec-documents-loader.service';

/**
 * 1C → ERP projections (plan E4 «onec-sync»): the documents loader writes the shared 1C document layer
 * (onec_documents*) and calls consumer ports; business modules register as consumers and never the reverse.
 */
@Module({
  imports: [DatabaseModule, OnecAgentModule],
  providers: [OnecDocumentConsumers, OnecDocumentsLoaderService],
  exports: [OnecDocumentConsumers],
})
export class OnecSyncModule {}
