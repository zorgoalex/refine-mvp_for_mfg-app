import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { DatabaseService } from '../../database/database.service';
import { PgUserRepository } from './adapters/pg-user-repository';
import { UnavailableUserRepository } from './adapters/unavailable-user-repository';
import { UserService } from './application/user.service';
import { UsersRuntimeConfigService } from './http/users-runtime-config.service';
import { UsersController } from './http/users.controller';

@Module({
  imports: [DatabaseModule],
  controllers: [UsersController],
  providers: [
    UsersRuntimeConfigService,
    {
      provide: UserService,
      useFactory: (database: DatabaseService) =>
        new UserService({
          users: database.isConfigured
            ? new PgUserRepository(database)
            : new UnavailableUserRepository(),
          database,
        }),
      inject: [DatabaseService],
    },
  ],
})
export class UsersModule {}
