import { Logger, Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { DatabaseService } from '../../database/database.service';
import { AuditService } from '../../common/audit/audit.service';
import { CrmSyncRuntimeConfigService } from './http/crm-sync-runtime-config.service';
import { PgCrmSourceRepository } from './adapters/pg-crm-source-repository';
import { UnavailableCrmSourceRepository } from './adapters/unavailable-crm-source-repository';
import { PgCrmSyncMappingRepository } from './adapters/pg-crm-sync-mapping-repository';
import { PgCrmSyncOutboxRepository } from './adapters/pg-crm-sync-outbox-repository';
import { Bitrix24ApiClient, NoopBitrix24ApiClient } from './adapters/bitrix24-api-client';
import { FailingBitrix24ApiClient } from './adapters/failing-bitrix24-api-client';
import { Bitrix24SyncConsumer } from './application/bitrix24-sync-consumer';
import { CrmSyncRelayService } from './application/crm-sync-relay.service';
import { CrmSyncRelaySchedulerService } from './application/crm-sync-relay-scheduler.service';

@Module({
  imports: [DatabaseModule],
  providers: [
    CrmSyncRuntimeConfigService,
    AuditService,
    PgCrmSyncMappingRepository,
    PgCrmSyncOutboxRepository,
    {
      provide: CrmSyncRelayService,
      useFactory: (
        database: DatabaseService,
        config: CrmSyncRuntimeConfigService,
        mapping: PgCrmSyncMappingRepository,
        outboxRepo: PgCrmSyncOutboxRepository,
        audit: AuditService,
      ) => {
        // Source repository — falls back to no-op if DB is not configured.
        const source = database.isConfigured
          ? new PgCrmSourceRepository(database)
          : new UnavailableCrmSourceRepository();

        const bitrixConfig = config.getBitrix24();
        const bitrixLogger = new Logger(Bitrix24ApiClient.name);
        const realBitrix = bitrixConfig.webhookUrl
          ? new Bitrix24ApiClient(
            bitrixConfig.webhookUrl,
            undefined,
            bitrixConfig.requestTimeoutMs,
            {
              maxRequestsPerSecond: bitrixConfig.maxRequestsPerSecond,
              limitRetryMaxAttempts: bitrixConfig.limitRetryMaxAttempts,
              queryLimitBaseDelayMs: bitrixConfig.queryLimitBaseDelayMs,
              operationLimitFallbackDelayMs: bitrixConfig.operationLimitFallbackDelayMs,
              onLimitRetry: ({ method, code, attempt, maxAttempts, delayMs }) => {
                bitrixLogger.warn(
                  `rate-limit retry method=${method} code=${code} ` +
                  `attempt=${attempt}/${maxAttempts} delayMs=${delayMs}`,
                );
              },
              onNetworkRetry: ({ method, code, attempt, maxAttempts, delayMs }) => {
                bitrixLogger.warn(
                  `network retry method=${method} code=${code} ` +
                  `attempt=${attempt}/${maxAttempts} delayMs=${delayMs}`,
                );
              },
            },
          )
          : new FailingBitrix24ApiClient();
        const noopBitrix = new NoopBitrix24ApiClient();
        const options = {
          erpBaseUrl: bitrixConfig.erpBaseUrl,
          currencyId: bitrixConfig.currencyId,
          assignedById: bitrixConfig.assignedById,
          paySystemId: bitrixConfig.paySystemId ?? 1,
        };

        const consumer = new Bitrix24SyncConsumer({
          source,
          bitrix: realBitrix,
          mapping,
          db: database,
          options,
          durablePaymentCreates: true,
        });

        const dryRunConsumer = new Bitrix24SyncConsumer({
          source,
          bitrix: noopBitrix,
          mapping,
          db: database,
          options,
          durablePaymentCreates: false,
        });

        return new CrmSyncRelayService({
          outboxRepo,
          consumer,
          dryRunConsumer,
          mapping,
          audit,
          db: database,
          config,
        });
      },
      inject: [
        DatabaseService,
        CrmSyncRuntimeConfigService,
        PgCrmSyncMappingRepository,
        PgCrmSyncOutboxRepository,
        AuditService,
      ],
    },
    {
      provide: CrmSyncRelaySchedulerService,
      useFactory: (relay: CrmSyncRelayService, config: CrmSyncRuntimeConfigService) =>
        new CrmSyncRelaySchedulerService(relay, config),
      inject: [CrmSyncRelayService, CrmSyncRuntimeConfigService],
    },
  ],
})
export class CrmSyncModule {}
