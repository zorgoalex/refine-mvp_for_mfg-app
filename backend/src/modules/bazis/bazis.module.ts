import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { DatabaseService } from '../../database/database.service';
import { PgBazisRepository } from './adapters/pg-bazis-repository';
import { UnavailableBazisRepository } from './adapters/unavailable-bazis-repository';
import { BazisService } from './application/bazis.service';
import { BazisController } from './http/bazis.controller';
import { BazisRuntimeConfigService } from './http/bazis-runtime-config.service';

@Module({
  imports: [DatabaseModule],
  controllers: [BazisController],
  providers: [
    BazisRuntimeConfigService,
    {
      provide: BazisService,
      useFactory: (database: DatabaseService) =>
        new BazisService({
          repository: database.isConfigured
            ? new PgBazisRepository(database)
            : new UnavailableBazisRepository(),
        }),
      inject: [DatabaseService],
    },
  ],
  exports: [BazisRuntimeConfigService, BazisService],
})
export class BazisModule {}
