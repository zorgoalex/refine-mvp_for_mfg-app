import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BackendEnv } from '../../config/env.validation';
import { DatabaseModule } from '../../database/database.module';
import { DatabaseService } from '../../database/database.service';
import { PgOnecReceiptsReadRepository } from './adapters/pg-onec-receipts-read-repository';
import { OnecReceiptsService, type OnecReceiptsSettings } from './application/onec-receipts.service';
import { OnecReceiptsController } from './http/onec-receipts.controller';

export function onecReceiptsSettings(config: ConfigService<BackendEnv, true>): OnecReceiptsSettings {
  const series = config.get('BACKEND_ONEC_ORDER_NUMBER_SERIES', { infer: true });
  return {
    viewEnabled: config.get('BACKEND_ENABLE_ONEC_AGENT', { infer: true }) === true
      && config.get('BACKEND_ONEC_PAYMENT_MATCHING_VIEW', { infer: true }) === true,
    series: series ? series : null,
  };
}

/**
 * Сверка поступлений 1С с платежами заказов ERP (план 2026-10-04-onec-incoming-payments). Срез A — чтение:
 * новых писателей нет, таблицы сверок пусты.
 */
@Module({
  imports: [DatabaseModule],
  controllers: [OnecReceiptsController],
  providers: [
    {
      provide: OnecReceiptsService,
      useFactory: (database: DatabaseService, config: ConfigService<BackendEnv, true>) =>
        new OnecReceiptsService({
          read: new PgOnecReceiptsReadRepository(database),
          settings: () => onecReceiptsSettings(config),
          auditClient: database,
        }),
      inject: [DatabaseService, ConfigService],
    },
  ],
})
export class PaymentsOnecModule {}
