import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { PermissionsGuard } from '../../permissions/permissions.guard';
import { PermissionsModule } from '../../permissions/permissions.module';
import { OnecAgentModule } from '../onec-agent/onec-agent.module';
import { DuplicateEngineRepository } from './duplicate-engine.repository';
import { DuplicateJournalRepository } from './duplicate-journal.repository';
import { IntegrationDuplicatesController } from './integration-duplicates.controller';
import { IntegrationDuplicatesService } from './integration-duplicates.service';

/** Journal of duplicates of integrations (ERP / Bitrix24 / 1C): search, cleanup of 1C data, the journal API. */
@Module({
  imports: [DatabaseModule, PermissionsModule, OnecAgentModule],
  controllers: [IntegrationDuplicatesController],
  providers: [DuplicateEngineRepository, DuplicateJournalRepository, IntegrationDuplicatesService, PermissionsGuard],
})
export class IntegrationDuplicatesModule {}
