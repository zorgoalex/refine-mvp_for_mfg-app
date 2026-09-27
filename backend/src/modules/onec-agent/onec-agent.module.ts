import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { PermissionsModule } from '../../permissions/permissions.module';
import { PgOnecRepository } from './adapters/pg-onec-repository';
import { OnecAdminService } from './application/onec-admin.service';
import { OnecAgentProtocolService } from './application/onec-agent-protocol.service';
import { OnecAlertProjector } from './application/onec-alert-projector';
import { OnecAuditWriter } from './application/onec-audit';
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
  ],
})
export class OnecAgentModule {}
