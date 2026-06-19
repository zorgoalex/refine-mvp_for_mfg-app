import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { DatabaseService } from '../../database/database.service';
import { AuditService } from '../../common/audit/audit.service';
import { CrmSyncRuntimeConfigService } from './http/crm-sync-runtime-config.service';
import { PgCrmSourceRepository } from './adapters/pg-crm-source-repository';
import { UnavailableCrmSourceRepository } from './adapters/unavailable-crm-source-repository';
import { PgCrmSyncMappingRepository } from './adapters/pg-crm-sync-mapping-repository';
import { PgCrmSyncOutboxRepository } from './adapters/pg-crm-sync-outbox-repository';
import { TwentyApiClient, NoopTwentyApiClient } from './adapters/twenty-api-client';
import { TwentySyncConsumer } from './application/twenty-sync-consumer';
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

        // Twenty API client — only build the REAL client when credentials are present.
        // Never construct TwentyApiClient with empty baseUrl/apiKey.
        const tw = config.getTwenty();
        const realTwenty =
          tw.baseUrl && tw.apiKey
            ? new TwentyApiClient(tw.baseUrl, tw.apiKey)
            : null;

        // Noop client is always constructed — used for dryRunConsumer and as fallback.
        const noopTwenty = new NoopTwentyApiClient();

        // Real consumer (uses live Twenty client, or Noop if creds absent — relay
        // will be disabled by flags.enabled anyway).
        const consumer = new TwentySyncConsumer({
          source,
          twenty: realTwenty ?? noopTwenty,
          mapping,
          db: database,
        });

        // Dry-run consumer — always backed by Noop (zero real HTTP writes).
        const dryRunConsumer = new TwentySyncConsumer({
          source,
          twenty: noopTwenty,
          mapping,
          db: database,
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
