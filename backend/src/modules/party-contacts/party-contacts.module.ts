import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { PermissionsGuard } from '../../permissions/permissions.guard';
import { PermissionsModule } from '../../permissions/permissions.module';
import { ClientCounterpartyRepository } from './client-counterparty.repository';
import { PartyContactsController } from './party-contacts.controller';
import { PartyContactsRepository } from './party-contacts.repository';
import { SupplierCounterpartyRepository } from './supplier-counterparty.repository';

/** Contacts of suppliers, vendors and clients, and the supplier / client ↔ 1C counterparty links (the directories themselves stay on Hasura). */
@Module({
  imports: [DatabaseModule, PermissionsModule],
  controllers: [PartyContactsController],
  providers: [PartyContactsRepository, SupplierCounterpartyRepository, ClientCounterpartyRepository, PermissionsGuard],
  exports: [PartyContactsRepository, SupplierCounterpartyRepository, ClientCounterpartyRepository],
})
export class PartyContactsModule {}
