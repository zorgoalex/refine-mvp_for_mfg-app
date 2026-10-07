import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DatabaseModule } from '../../database/database.module';
import { DatabaseService } from '../../database/database.service';
import { PgUserRepository } from './adapters/pg-user-repository';
import { PermissionsModule } from '../../permissions/permissions.module';
import { PermissionsService } from '../../permissions/permissions.service';
import { UnavailableUserRepository } from './adapters/unavailable-user-repository';
import { UserService } from './application/user.service';
import { UsersRuntimeConfigService } from './http/users-runtime-config.service';
import { UsersController } from './http/users.controller';

@Module({
  imports: [DatabaseModule, PermissionsModule],
  controllers: [UsersController],
  providers: [
    UsersRuntimeConfigService,
    {
      provide: UserService,
      useFactory: (database: DatabaseService, permissions: PermissionsService, config: ConfigService) =>
        new UserService({
          users: database.isConfigured
            // Server-only secret of the auth module, used as the HMAC key of passwords in idempotent requests.
            ? new PgUserRepository(database, permissions, config.get<string>('REFRESH_TOKEN_PEPPER') || undefined)
            : new UnavailableUserRepository(),
          database,
          permissions,
        }),
      inject: [DatabaseService, PermissionsService, ConfigService],
    },
  ],
})
export class UsersModule {}
