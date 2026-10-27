import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { PermissionsGuard } from '../../permissions/permissions.guard';
import { PermissionsModule } from '../../permissions/permissions.module';
import { ClientPhonesModule } from '../client-phones/client-phones.module';
import { PartyContactsModule } from '../party-contacts/party-contacts.module';
import { ClientContactsListRepository } from './client-contacts-list.repository';
import { ClientContactsController } from './client-contacts.controller';

/** «Контакты клиентов»: the list of all client contacts with in-place editing (writes go through the owning modules). */
@Module({
  imports: [DatabaseModule, PermissionsModule, PartyContactsModule, ClientPhonesModule],
  controllers: [ClientContactsController],
  providers: [ClientContactsListRepository, PermissionsGuard],
})
export class ClientContactsModule {}
