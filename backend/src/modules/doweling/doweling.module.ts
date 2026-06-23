import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { DatabaseService } from '../../database/database.service';
import { PgDowelingRepository } from './adapters/pg-doweling-repository';
import { UnavailableDowelingRepository } from './adapters/unavailable-doweling-repository';
import { DowelingService } from './application/doweling.service';
import { DowelingRuntimeConfigService } from './http/doweling-runtime-config.service';
import { DowelingController } from './http/doweling.controller';

// Factory branches ONLY on database.isConfigured (DB-outage → Unavailable repo). The feature flag is NOT
// read here: the 503 flag-off gate is request-time in the controller via DowelingRuntimeConfigService.
@Module({
  imports: [DatabaseModule],
  controllers: [DowelingController],
  providers: [
    DowelingRuntimeConfigService,
    {
      provide: DowelingService,
      useFactory: (database: DatabaseService) =>
        new DowelingService({
          doweling: database.isConfigured
            ? new PgDowelingRepository(database)
            : new UnavailableDowelingRepository(),
        }),
      inject: [DatabaseService],
    },
  ],
})
export class DowelingModule {}
