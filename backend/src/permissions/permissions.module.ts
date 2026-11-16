import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { AccessGroupsController, UserAccessGroupsController } from './access-groups/access-groups.controller';
import { PgAccessGroupsRepository } from './access-groups/pg-access-groups.repository';
import { PermissionsController } from './permissions.controller';
import { PermissionsService } from './permissions.service';

@Module({
  imports: [DatabaseModule],
  controllers: [PermissionsController, AccessGroupsController, UserAccessGroupsController],
  providers: [PermissionsService, PgAccessGroupsRepository],
  exports: [PermissionsService],
})
export class PermissionsModule {}
