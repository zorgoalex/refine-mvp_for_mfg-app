import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { DatabaseService } from '../../database/database.service';
import { PgClientPhoneRepository } from './adapters/pg-client-phone-repository';
import { UnavailableClientPhoneRepository } from './adapters/unavailable-client-phone-repository';
import { ClientPhoneService } from './application/client-phone.service';
import { ClientPhonesRuntimeConfigService } from './http/client-phones-runtime-config.service';
import { ClientPhonesController } from './http/client-phones.controller';

@Module({
  imports: [DatabaseModule],
  controllers: [ClientPhonesController],
  providers: [
    ClientPhonesRuntimeConfigService,
    {
      provide: ClientPhoneService,
      useFactory: (database: DatabaseService) =>
        new ClientPhoneService({
          clientPhones: database.isConfigured
            ? new PgClientPhoneRepository(database)
            : new UnavailableClientPhoneRepository(),
        }),
      inject: [DatabaseService],
    },
  ],
})
export class ClientPhonesModule {}
