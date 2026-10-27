import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { PermissionsGuard } from '../../permissions/permissions.guard';
import { PermissionsModule } from '../../permissions/permissions.module';
import { OnecAgentModule } from '../onec-agent/onec-agent.module';
import { ClientCounterpartyRepository } from './client-counterparty.repository';
import { ClientOnecDocumentsController } from './client-onec-documents.controller';
import { ClientOnecDocumentsService } from './client-onec-documents.service';
import { PartyContactsController } from './party-contacts.controller';
import { PartyContactsRepository } from './party-contacts.repository';
import { SupplierCounterpartyRepository } from './supplier-counterparty.repository';
import { SupplierOnecContactsRepository } from './supplier-onec-contacts.repository';
import { SupplierOnecContactsService } from './supplier-onec-contacts.service';

/** Contacts of suppliers, vendors and clients, and the supplier / client ↔ 1C counterparty links (the directories themselves stay on Hasura). */
@Module({
  imports: [DatabaseModule, PermissionsModule, OnecAgentModule],
  controllers: [PartyContactsController, ClientOnecDocumentsController],
  providers: [PartyContactsRepository, SupplierCounterpartyRepository, SupplierOnecContactsRepository, SupplierOnecContactsService, ClientCounterpartyRepository, ClientOnecDocumentsService, PermissionsGuard],
  exports: [PartyContactsRepository, SupplierCounterpartyRepository, ClientCounterpartyRepository],
})
export class PartyContactsModule {}
