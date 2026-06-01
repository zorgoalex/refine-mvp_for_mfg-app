import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { DatabaseService } from '../../database/database.service';
import { PgProjectRepository, UnavailableProjectRepository } from './project.repository';
import { ProjectsController } from './projects.controller';
import { ProjectsRuntimeConfigService } from './projects-runtime-config.service';
import { ProjectsService } from './projects.service';
import { ProjectOrderReportController } from './reporting/project-order-report.controller';
import {
  PgProjectOrderReportRepository,
  UnavailableProjectOrderReportRepository,
} from './reporting/project-order-report.repository';
import { ProjectOrderReportService } from './reporting/project-order-report.service';

@Module({
  imports: [DatabaseModule],
  controllers: [ProjectsController, ProjectOrderReportController],
  providers: [
    ProjectsRuntimeConfigService,
    {
      provide: ProjectsService,
      useFactory: (database: DatabaseService) =>
        new ProjectsService({
          projects: database.isConfigured
            ? new PgProjectRepository(database)
            : new UnavailableProjectRepository(),
        }),
      inject: [DatabaseService],
    },
    {
      provide: ProjectOrderReportService,
      useFactory: (database: DatabaseService) =>
        new ProjectOrderReportService({
          reports: database.isConfigured
            ? new PgProjectOrderReportRepository(database)
            : new UnavailableProjectOrderReportRepository(),
        }),
      inject: [DatabaseService],
    },
  ],
})
export class ProjectsModule {}
