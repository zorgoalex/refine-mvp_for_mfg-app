import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { DatabaseService } from '../../database/database.service';
import { PgAuditLogRepository } from './adapters/pg-audit-log-repository';
import { AuditQueryService } from './application/audit-query.service';
import { AuditController } from './http/audit.controller';

@Module({
  imports: [DatabaseModule],
  controllers: [AuditController],
  providers: [
    {
      provide: AuditQueryService,
      useFactory: (database: DatabaseService) =>
        new AuditQueryService({ repository: new PgAuditLogRepository(database) }),
      inject: [DatabaseService],
    },
  ],
})
export class AuditModule {}
