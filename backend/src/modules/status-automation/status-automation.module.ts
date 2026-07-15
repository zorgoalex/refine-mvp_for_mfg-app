import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { DatabaseService } from '../../database/database.service';
import { PgStatusAutomationRepository } from './adapters/pg-status-automation-repository';
import { StatusAutomationRulesService } from './application/status-automation-rules.service';
import { StatusAutomationController } from './http/status-automation.controller';

@Module({
  imports: [DatabaseModule],
  controllers: [StatusAutomationController],
  providers: [
    {
      provide: StatusAutomationRulesService,
      useFactory: (database: DatabaseService) =>
        new StatusAutomationRulesService({
          repository: new PgStatusAutomationRepository(database),
          database,
        }),
      inject: [DatabaseService],
    },
  ],
})
export class StatusAutomationModule {}
