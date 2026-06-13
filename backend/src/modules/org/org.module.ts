import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { DatabaseService } from '../../database/database.service';
import { PermissionsModule } from '../../permissions/permissions.module';
import { OrgController } from './org.controller';
import { OrgRuntimeConfigService } from './org-runtime-config.service';
import { OrgService } from './org.service';
import { PgOrgRepository, UnavailableOrgRepository } from './org.repository';

@Module({
  imports: [DatabaseModule, PermissionsModule],
  controllers: [OrgController],
  providers: [
    OrgRuntimeConfigService,
    {
      provide: OrgService,
      useFactory: (database: DatabaseService) =>
        new OrgService({
          repository: database.isConfigured ? new PgOrgRepository(database) : new UnavailableOrgRepository(),
        }),
      inject: [DatabaseService],
    },
  ],
})
export class OrgModule {}
