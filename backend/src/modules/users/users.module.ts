import { Module } from '@nestjs/common';
import { UnavailableUserRepository } from './adapters/unavailable-user-repository';
import { UserService } from './application/user.service';
import { UsersRuntimeConfigService } from './http/users-runtime-config.service';
import { UsersController } from './http/users.controller';

@Module({
  controllers: [UsersController],
  providers: [
    UsersRuntimeConfigService,
    {
      provide: UserService,
      useFactory: () =>
        new UserService({
          users: new UnavailableUserRepository(),
        }),
    },
  ],
})
export class UsersModule {}
