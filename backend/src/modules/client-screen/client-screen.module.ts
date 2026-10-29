import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { PermissionsModule } from '../../permissions/permissions.module';
import { ClientScreenController } from './client-screen.controller';
import { ClientScreenRepository } from './client-screen.repository';
import { ClientScreenService } from './client-screen.service';

/** Settings of the customer screen (the second-monitor mirror of an order); the presentation itself is frontend-only. */
@Module({
  imports: [DatabaseModule, PermissionsModule],
  controllers: [ClientScreenController],
  providers: [ClientScreenRepository, ClientScreenService],
})
export class ClientScreenModule {}
