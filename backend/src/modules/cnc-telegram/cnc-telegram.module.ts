import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { DatabaseService } from '../../database/database.service';
import { PgCncTelegramRepository } from './adapters/pg-cnc-telegram-repository';
import { UnavailableCncTelegramRepository } from './adapters/unavailable-cnc-telegram-repository';
import { CncTelegramService } from './application/cnc-telegram.service';
import { CncTelegramController } from './http/cnc-telegram.controller';
import { CncTelegramRuntimeConfigService } from './http/cnc-telegram-runtime-config.service';

@Module({
  imports: [DatabaseModule],
  controllers: [CncTelegramController],
  providers: [
    CncTelegramRuntimeConfigService,
    {
      provide: CncTelegramService,
      useFactory: (database: DatabaseService) => {
        const repository = database.isConfigured
          ? new PgCncTelegramRepository(database)
          : new UnavailableCncTelegramRepository();
        return new CncTelegramService({
          packets: repository,
          deniedAudit: repository,
        });
      },
      inject: [DatabaseService],
    },
  ],
})
export class CncTelegramModule {}
