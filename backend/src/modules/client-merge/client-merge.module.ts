import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { PermissionsGuard } from '../../permissions/permissions.guard';
import { PermissionsModule } from '../../permissions/permissions.module';
import { PartyContactsModule } from '../party-contacts/party-contacts.module';
import { ClientMergeController } from './client-merge.controller';
import { ClientMergeService } from './client-merge.service';

/** Merge of duplicate clients from the journal of duplicates (D1), its undo and the alignment of deadline copies. */
@Module({
  imports: [DatabaseModule, PermissionsModule, PartyContactsModule],
  controllers: [ClientMergeController],
  providers: [ClientMergeService, PermissionsGuard],
})
export class ClientMergeModule {}
