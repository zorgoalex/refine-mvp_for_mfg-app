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
import { CncTelegramWorkerSessionController } from './http/cnc-telegram-worker-session.controller';
import { CncTelegramWorkerSessionService } from './application/cnc-telegram-worker-session.service';
import { PgCncTelegramWorkerSessionRepository } from './adapters/pg-cnc-telegram-worker-session-repository';
import { PgCncTelegramImportRepository } from './adapters/pg-cnc-telegram-import-repository';
import { CncTelegramImportService } from './application/cnc-telegram-import.service';
import { CncTelegramImportController } from './http/cnc-telegram-import.controller';
import { MdfBoardHistoryService } from './application/mdf-board-history.service';
import { PgMdfBoardHistoryRepository } from './adapters/pg-mdf-board-history-repository';

@Module({
  imports: [DatabaseModule],
  controllers: [
    CncTelegramController,
    CncTelegramWorkerAuditController,
    CncTelegramMediaController,
    CncTelegramWorkerSessionController,
    CncTelegramImportController,
  ],
  providers: [
    CncTelegramRuntimeConfigService,
    {
      provide: MdfBoardHistoryService,
      useFactory: (database: DatabaseService) =>
        new MdfBoardHistoryService(new PgMdfBoardHistoryRepository(database)),
      inject: [DatabaseService],
    },
    {
      provide: CncTelegramWorkerSessionService,
      useFactory: (database: DatabaseService, config: ConfigService<BackendEnv, true>) => (
        new CncTelegramWorkerSessionService(
          new PgCncTelegramWorkerSessionRepository(database),
          config,
        )
      ),
      inject: [DatabaseService, ConfigService],
    },
    {
      provide: CncTelegramMediaService,
      useFactory: (
        database: DatabaseService,
        config: ConfigService<BackendEnv, true>,
        session: CncTelegramWorkerSessionService,
      ) => (
        new CncTelegramMediaService(new PgCncTelegramMediaRepository(database), config, session)
      ),
      inject: [DatabaseService, ConfigService, CncTelegramWorkerSessionService],
    },
    {
      provide: CncTelegramWorkerAuditService,
      useFactory: (
        database: DatabaseService,
        config: ConfigService<BackendEnv, true>,
        session: CncTelegramWorkerSessionService,
      ) => {
        const deniedAudit = database.isConfigured
          ? new PgCncTelegramRepository(database)
          : new UnavailableCncTelegramRepository();
        return new CncTelegramWorkerAuditService(
          new PgCncTelegramWorkerAuditRepository(database),
          config,
          deniedAudit,
          session,
        );
      },
      inject: [DatabaseService, ConfigService, CncTelegramWorkerSessionService],
    },
    {
      provide: CncTelegramService,
      useFactory: (
        database: DatabaseService,
        config: ConfigService<BackendEnv, true>,
      ) => {
        const repository = database.isConfigured
          ? new PgCncTelegramRepository(database)
          : new UnavailableCncTelegramRepository();
        return new CncTelegramService({
          packets: repository,
          deniedAudit: repository,
          backgroundIngestEnabled: config.get('CNC_TELEGRAM_BACKGROUND_INGEST_ENABLED', { infer: true }),
          manualSvgDestinationChatIds: (
            config.get('CNC_TELEGRAM_ALLOWED_CHAT_IDS', { infer: true }) ?? ''
          ).split(',').map((value) => value.trim()).filter(Boolean),
        });
      },
      inject: [DatabaseService, ConfigService],
    },
    {
      provide: CncTelegramImportService,
      useFactory: (database: DatabaseService, config: ConfigService<BackendEnv, true>, session: CncTelegramWorkerSessionService) => {
        const packetRepository = database.isConfigured ? new PgCncTelegramRepository(database) : new UnavailableCncTelegramRepository();
        return new CncTelegramImportService(new PgCncTelegramImportRepository(database, packetRepository), config, session);
      },
      inject: [DatabaseService, ConfigService, CncTelegramWorkerSessionService],
    },
  ],
})
export class CncTelegramModule {}
