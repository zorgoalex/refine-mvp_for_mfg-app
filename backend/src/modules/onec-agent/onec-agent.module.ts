import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { PermissionsModule } from '../../permissions/permissions.module';
import { PgOnecCommandRepository } from './adapters/pg-onec-command-repository';
import { PgOnecEtlRepository } from './adapters/pg-onec-etl-repository';
import { PgOnecMatchingRepository } from './adapters/pg-onec-matching-repository';
import { PgOnecRepository } from './adapters/pg-onec-repository';
import { OnecAdminService } from './application/onec-admin.service';
import { OnecAgentProtocolService } from './application/onec-agent-protocol.service';
import { OnecAlertProjector } from './application/onec-alert-projector';
import { OnecAuditWriter } from './application/onec-audit';
import { OnecCommandWakeups } from './application/onec-command-wakeups';
import { OnecCommandsService } from './application/onec-commands.service';
import { OnecEtlAdminService } from './application/onec-etl-admin.service';
import { OnecEtlCompletionService } from './application/onec-etl-completion.service';
import { OnecEtlIngestService } from './application/onec-etl-ingest.service';
import { OnecEtlParserService } from './application/onec-etl-parser.service';
import { OnecEtlRevocationService } from './application/onec-etl-revocation.service';
import { OnecMatchingService } from './application/onec-matching.service';
import { OnecMonitorService } from './application/onec-monitor.service';
import { OnecAdminController } from './http/onec-admin.controller';
import { OnecAgentAuthGuard } from './http/onec-agent-auth.guard';
import { OnecAgentController } from './http/onec-agent.controller';
import { OnecPermissionsGuard } from './http/onec-permissions.guard';
import { OnecRuntimeConfigService } from './onec-runtime-config.service';

/**
 * 1C agent integration (transport). Business mapping (orders, payments,
 * catalog) lives in a separate module and talks to this one only through
 * its queue port and module outbox events.
 */
@Module({
  imports: [DatabaseModule, PermissionsModule],
  controllers: [OnecAgentController, OnecAdminController],
  providers: [
    OnecRuntimeConfigService,
    PgOnecRepository,
    OnecAuditWriter,
    OnecAgentProtocolService,
    OnecAdminService,
    OnecAlertProjector,
    OnecMonitorService,
    OnecAgentAuthGuard,
    OnecPermissionsGuard,
    PgOnecCommandRepository,
    OnecCommandWakeups,
    OnecCommandsService,
    PgOnecEtlRepository,
    OnecEtlParserService,
    OnecEtlIngestService,
    OnecEtlCompletionService,
    OnecEtlAdminService,
    OnecEtlRevocationService,
    PgOnecMatchingRepository,
    OnecMatchingService,
  ],
  // Port for business modules (E4): OnecCommandsService.enqueue(tx, …).
  exports: [OnecCommandsService],
})
export class OnecAgentModule {}
