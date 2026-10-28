import { Inject, Module, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BackendEnv } from '../../config/env.validation';
import { DatabaseModule } from '../../database/database.module';
import { DatabaseService } from '../../database/database.service';
import { OnecSyncModule } from '../onec-sync/onec-sync.module';
import { PgOnecReceiptsCommandRepository } from './adapters/pg-onec-receipts-command-repository';
import { PgOnecReceiptsReadRepository } from './adapters/pg-onec-receipts-read-repository';
import { configureOnecMatching } from './application/onec-match-transitions';
import { OnecReceiptsAutoMatcher, type AutoMatchSettings } from './application/onec-receipts-auto-match.service';
import { OnecDocumentsEvents } from '../onec-sync/application/onec-documents-events';
import { OnecReceiptsLoaderConsumer } from './application/onec-receipts-loader-consumer';
import { OnecReceiptsService, type OnecReceiptsSettings } from './application/onec-receipts.service';
import { OnecReceiptsController } from './http/onec-receipts.controller';

export function onecReceiptsSettings(config: ConfigService<BackendEnv, true>): OnecReceiptsSettings {
  const series = config.get('BACKEND_ONEC_ORDER_NUMBER_SERIES', { infer: true });
  const viewEnabled = config.get('BACKEND_ENABLE_ONEC_AGENT', { infer: true }) === true
    && config.get('BACKEND_ONEC_PAYMENT_MATCHING_VIEW', { infer: true }) === true;
  return {
    viewEnabled,
    commandsEnabled: viewEnabled && config.get('BACKEND_ONEC_PAYMENT_MATCHING_COMMANDS', { infer: true }) === true,
    series: series ? series : null,
  };
}

export function autoMatchSettings(config: ConfigService<BackendEnv, true>): AutoMatchSettings {
  const actor = config.get('BACKEND_ONEC_PAYMENT_MATCH_ACTOR_USER_ID', { infer: true });
  const actorUserId = typeof actor === 'number' ? actor : null;
  return {
    enabled: onecReceiptsSettings(config).commandsEnabled && config.get('BACKEND_ONEC_PAYMENT_AUTO_MATCH', { infer: true }) === true
      && actorUserId !== null,
    actorUserId,
  };
}

/**
 * Сверка поступлений 1С с платежами заказов ERP (план 2026-10-04-onec-incoming-payments). Срез A — чтение; срез B —
 * ручные команды и защита сверок: потребитель загрузчика и хуки писателей платежей (onec-match-transitions)
 * работают при любых флагах.
 */
@Module({
  imports: [DatabaseModule, OnecSyncModule],
  controllers: [OnecReceiptsController],
  providers: [
    OnecReceiptsLoaderConsumer,
    {
      provide: PgOnecReceiptsCommandRepository,
      useFactory: (database: DatabaseService, config: ConfigService<BackendEnv, true>) =>
        new PgOnecReceiptsCommandRepository(database, () => onecReceiptsSettings(config).series),
      inject: [DatabaseService, ConfigService],
    },
    {
      provide: OnecReceiptsAutoMatcher,
      useFactory: (database: DatabaseService, config: ConfigService<BackendEnv, true>, commands: PgOnecReceiptsCommandRepository, events: OnecDocumentsEvents) =>
        new OnecReceiptsAutoMatcher({ database, commands, settings: () => autoMatchSettings(config), events }),
      inject: [DatabaseService, ConfigService, PgOnecReceiptsCommandRepository, OnecDocumentsEvents],
    },
    {
      provide: OnecReceiptsService,
      useFactory: (database: DatabaseService, config: ConfigService<BackendEnv, true>, commands: PgOnecReceiptsCommandRepository, autoMatcher: OnecReceiptsAutoMatcher) =>
        new OnecReceiptsService({
          read: new PgOnecReceiptsReadRepository(database),
          commands,
          autoMatcher,
          settings: () => onecReceiptsSettings(config),
          auditClient: database,
        }),
      inject: [DatabaseService, ConfigService, PgOnecReceiptsCommandRepository, OnecReceiptsAutoMatcher],
    },
  ],
})
export class PaymentsOnecModule implements OnModuleInit, OnModuleDestroy {
  constructor(
    @Inject(ConfigService) private readonly config: ConfigService<BackendEnv, true>,
    @Inject(OnecReceiptsAutoMatcher) private readonly autoMatcher: OnecReceiptsAutoMatcher,
  ) {}

  /** The writers' hooks read the series and the commands flag from here (they run outside this module's DI). */
  onModuleInit(): void {
    const settings = onecReceiptsSettings(this.config);
    configureOnecMatching({ series: settings.series, commandsEnabled: settings.commandsEnabled });
    this.autoMatcher.start();
  }

  onModuleDestroy(): void {
    this.autoMatcher.stop();
    configureOnecMatching(null);
  }
}
