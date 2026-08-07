import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { DatabaseService } from '../../database/database.service';
import { PgCncTelegramRepository } from './adapters/pg-cnc-telegram-repository';
import { UnavailableCncTelegramRepository } from './adapters/unavailable-cnc-telegram-repository';
import { CncTelegramService } from './application/cnc-telegram.service';
import { CncTelegramController } from './http/cnc-telegram.controller';
import { CncTelegramRuntimeConfigService } from './http/cnc-telegram-runtime-config.service';
import { ConfigService } from '@nestjs/config';
import type { BackendEnv } from '../../config/env.validation';
import { PgCncTelegramWorkerAuditRepository } from './adapters/pg-cnc-telegram-worker-audit-repository';
import { CncTelegramWorkerAuditService } from './application/cnc-telegram-worker-audit.service';
import { CncTelegramWorkerAuditController } from './http/cnc-telegram-worker-audit.controller';
import { PgCncTelegramMediaRepository } from './adapters/pg-cnc-telegram-media-repository';
import { CncTelegramMediaService } from './application/cnc-telegram-media.service';
import { CncTelegramMediaController } from './http/cnc-telegram-media.controller';

@Module({
  imports: [DatabaseModule],
  controllers: [CncTelegramController, CncTelegramWorkerAuditController, CncTelegramMediaController],
  providers: [
    CncTelegramRuntimeConfigService,
    {
      provide: CncTelegramMediaService,
      useFactory: (database: DatabaseService, config: ConfigService<BackendEnv, true>) => (
        new CncTelegramMediaService(new PgCncTelegramMediaRepository(database), config)
      ),
      inject: [DatabaseService, ConfigService],
    },
    {
      provide: CncTelegramWorkerAuditService,
      useFactory: (database: DatabaseService, config: ConfigService<BackendEnv, true>) => {
        const deniedAudit = database.isConfigured
          ? new PgCncTelegramRepository(database)
          : new UnavailableCncTelegramRepository();
        return new CncTelegramWorkerAuditService(
          new PgCncTelegramWorkerAuditRepository(database),
          config,
          deniedAudit,
        );
      },
      inject: [DatabaseService, ConfigService],
    },
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
