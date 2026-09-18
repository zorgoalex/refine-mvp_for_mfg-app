import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { DatabaseService } from '../../database/database.service';
import { PgAuditLogRepository } from './adapters/pg-audit-log-repository';
import { AuditQueryService } from './application/audit-query.service';
import { AuditController } from './http/audit.controller';
import { BitrixAuditController } from './http/bitrix-audit.controller';
import { BitrixAuditService } from './application/bitrix-audit.service';
import { CrmSyncRuntimeConfigService } from '../crm-sync/http/crm-sync-runtime-config.service';

@Module({
  imports: [DatabaseModule],
  controllers: [AuditController, BitrixAuditController],
  providers: [
    CrmSyncRuntimeConfigService,
    { provide: BitrixAuditService, useFactory: (database: DatabaseService, config: CrmSyncRuntimeConfigService) => new BitrixAuditService(database, config), inject: [DatabaseService, CrmSyncRuntimeConfigService] },
    {
      provide: AuditQueryService,
      useFactory: (database: DatabaseService) =>
        new AuditQueryService({ repository: new PgAuditLogRepository(database) }),
      inject: [DatabaseService],
    },
  ],
})
export class AuditModule {}
