import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { DatabaseService } from '../../database/database.service';
import { PgBazisCutRepository } from './adapters/pg-bazis-cut-repository';
import { BazisCutService } from './application/bazis-cut.service';
import { BazisCutRuntimeConfigService } from './http/bazis-cut-runtime-config.service';
import { BazisCutSetsController } from './http/bazis-cut-sets.controller';

@Module({
  imports: [DatabaseModule],
  controllers: [BazisCutSetsController],
  providers: [
    BazisCutRuntimeConfigService,
    {
      provide: BazisCutService,
      useFactory: (database: DatabaseService) => new BazisCutService(new PgBazisCutRepository(database), undefined, database),
      inject: [DatabaseService],
    },
  ],
})
export class BazisCutModule {}
