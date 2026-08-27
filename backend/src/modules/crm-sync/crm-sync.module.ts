import { Logger, Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { PermissionsModule } from '../../permissions/permissions.module';
import { PermissionsGuard } from '../../permissions/permissions.guard';
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
import { Bitrix24LocalAppClient } from './reverse/bitrix24-local-app-client';
import { Bitrix24OAuthTokenSchedulerService } from './reverse/bitrix24-oauth-token-scheduler.service';
import { Bitrix24OAuthTokenService } from './reverse/bitrix24-oauth-token.service';
import { Bitrix24ReverseController } from './reverse/bitrix24-reverse.controller';
import { Bitrix24ReverseAdminController } from './reverse/bitrix24-reverse-admin.controller';
import { Bitrix24OrderConversionController } from './reverse/bitrix24-order-conversion.controller';
import { Bitrix24ReverseIngressService } from './reverse/bitrix24-reverse-ingress.service';
import { Bitrix24ReverseProcessorService } from './reverse/bitrix24-reverse-processor.service';
import { Bitrix24ReverseSchedulerService } from './reverse/bitrix24-reverse-scheduler.service';
import { PgBitrix24ReverseRepository } from './reverse/pg-bitrix24-reverse-repository';
import type { Bitrix24ApiPort } from './adapters/bitrix24-api-client';

const BITRIX24_API_PORT = Symbol('BITRIX24_API_PORT');
const BITRIX24_REVERSE_API_PORT = Symbol('BITRIX24_REVERSE_API_PORT');

@Module({
  imports: [DatabaseModule, PermissionsModule],
  controllers: [
    Bitrix24ReverseController,
    Bitrix24ReverseAdminController,
    Bitrix24OrderConversionController,
  ],
  providers: [
    CrmSyncRuntimeConfigService,
    AuditService,
    PgCrmSyncMappingRepository,
    PgCrmSyncOutboxRepository,
    PermissionsGuard,
    {
      provide: BITRIX24_API_PORT,
      useFactory: (config: CrmSyncRuntimeConfigService): Bitrix24ApiPort => {
        const bitrixConfig = config.getBitrix24();
        if (!bitrixConfig.webhookUrl) return new FailingBitrix24ApiClient();
        const bitrixLogger = new Logger(Bitrix24ApiClient.name);
        return new Bitrix24ApiClient(
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
        );
      },
      inject: [CrmSyncRuntimeConfigService],
    },
    {
      provide: PgBitrix24ReverseRepository,
      useFactory: (database: DatabaseService, audit: AuditService) =>
        new PgBitrix24ReverseRepository(database, audit),
      inject: [DatabaseService, AuditService],
    },
    {
      provide: Bitrix24LocalAppClient,
      useFactory: (config: CrmSyncRuntimeConfigService) =>
        new Bitrix24LocalAppClient(undefined, config.getBitrix24().requestTimeoutMs),
      inject: [CrmSyncRuntimeConfigService],
    },
    {
      provide: Bitrix24ReverseIngressService,
      useFactory: (
        repository: PgBitrix24ReverseRepository,
        config: CrmSyncRuntimeConfigService,
        localApp: Bitrix24LocalAppClient,
      ) => new Bitrix24ReverseIngressService(repository, config, localApp),
      inject: [
        PgBitrix24ReverseRepository,
        CrmSyncRuntimeConfigService,
        Bitrix24LocalAppClient,
      ],
    },
    {
      provide: Bitrix24OAuthTokenService,
      useFactory: (
        repository: PgBitrix24ReverseRepository,
        config: CrmSyncRuntimeConfigService,
      ) => new Bitrix24OAuthTokenService(repository, config),
      inject: [
        PgBitrix24ReverseRepository,
        CrmSyncRuntimeConfigService,
      ],
    },
    {
      provide: BITRIX24_REVERSE_API_PORT,
      useFactory: (
        config: CrmSyncRuntimeConfigService,
        tokens: Bitrix24OAuthTokenService,
      ): Bitrix24ApiPort => {
        const reverse = config.getReverseSync();
        const bitrixConfig = config.getBitrix24();
        const logger = new Logger('Bitrix24OAuthApiClient');
        return new Bitrix24ApiClient(
          `https://${reverse.portalDomain}/rest`,
          undefined,
          bitrixConfig.requestTimeoutMs,
          {
            maxRequestsPerSecond: bitrixConfig.maxRequestsPerSecond,
            limitRetryMaxAttempts: bitrixConfig.limitRetryMaxAttempts,
            queryLimitBaseDelayMs: bitrixConfig.queryLimitBaseDelayMs,
            operationLimitFallbackDelayMs: bitrixConfig.operationLimitFallbackDelayMs,
            getAccessToken: () => tokens.getAccessToken(reverse.portalDomain),
            refreshAccessToken: () =>
              tokens.forceRefreshAccessToken(reverse.portalDomain),
            onLimitRetry: ({ method, code, attempt, maxAttempts, delayMs }) => {
              logger.warn(
                `rate-limit retry method=${method} code=${code} ` +
                `attempt=${attempt}/${maxAttempts} delayMs=${delayMs}`,
              );
            },
            onNetworkRetry: ({ method, code, attempt, maxAttempts, delayMs }) => {
              logger.warn(
                `network retry method=${method} code=${code} ` +
                `attempt=${attempt}/${maxAttempts} delayMs=${delayMs}`,
              );
            },
          },
        );
      },
      inject: [CrmSyncRuntimeConfigService, Bitrix24OAuthTokenService],
    },
    {
      provide: Bitrix24ReverseProcessorService,
      useFactory: (
        repository: PgBitrix24ReverseRepository,
        bitrix: Bitrix24ApiPort,
        config: CrmSyncRuntimeConfigService,
      ) => new Bitrix24ReverseProcessorService(repository, bitrix, config),
      inject: [
        PgBitrix24ReverseRepository,
        BITRIX24_REVERSE_API_PORT,
        CrmSyncRuntimeConfigService,
      ],
    },
    {
      provide: Bitrix24OAuthTokenSchedulerService,
      useFactory: (
        tokens: Bitrix24OAuthTokenService,
        config: CrmSyncRuntimeConfigService,
      ) => new Bitrix24OAuthTokenSchedulerService(tokens, config),
      inject: [Bitrix24OAuthTokenService, CrmSyncRuntimeConfigService],
    },
    {
      provide: Bitrix24ReverseSchedulerService,
      useFactory: (
        processor: Bitrix24ReverseProcessorService,
        config: CrmSyncRuntimeConfigService,
      ) => new Bitrix24ReverseSchedulerService(processor, config),
      inject: [Bitrix24ReverseProcessorService, CrmSyncRuntimeConfigService],
    },
    {
      provide: CrmSyncRelayService,
      useFactory: (
        database: DatabaseService,
        config: CrmSyncRuntimeConfigService,
        mapping: PgCrmSyncMappingRepository,
        outboxRepo: PgCrmSyncOutboxRepository,
        audit: AuditService,
        realBitrix: Bitrix24ApiPort,
      ) => {
        // Source repository — falls back to no-op if DB is not configured.
        const source = database.isConfigured
          ? new PgCrmSourceRepository(database)
          : new UnavailableCrmSourceRepository();

        const bitrixConfig = config.getBitrix24();
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
        BITRIX24_API_PORT,
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
