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
import { ProjectOrderRelationCountsReportController } from './reporting/project-order-relation-counts-report.controller';
import {
  PgProjectOrderRelationCountsReportRepository,
  UnavailableProjectOrderRelationCountsReportRepository,
} from './reporting/project-order-relation-counts-report.repository';
import { ProjectOrderRelationCountsReportService } from './reporting/project-order-relation-counts-report.service';
import { ProjectOrderCreatedMonthCountsReportController } from './reporting/project-order-created-month-counts-report.controller';
import {
  PgProjectOrderCreatedMonthCountsReportRepository,
  UnavailableProjectOrderCreatedMonthCountsReportRepository,
} from './reporting/project-order-created-month-counts-report.repository';
import { ProjectOrderCreatedMonthCountsReportService } from './reporting/project-order-created-month-counts-report.service';
import { ProjectOrderStatusReportController } from './reporting/project-order-status-report.controller';
import {
  PgProjectOrderStatusReportRepository,
  UnavailableProjectOrderStatusReportRepository,
} from './reporting/project-order-status-report.repository';
import { ProjectOrderStatusReportService } from './reporting/project-order-status-report.service';

@Module({
  imports: [DatabaseModule],
  controllers: [
    ProjectsController,
    ProjectOrderReportController,
    ProjectOrderStatusReportController,
    ProjectOrderRelationCountsReportController,
    ProjectOrderCreatedMonthCountsReportController,
  ],
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
    {
      provide: ProjectOrderStatusReportService,
      useFactory: (database: DatabaseService) =>
        new ProjectOrderStatusReportService({
          reports: database.isConfigured
            ? new PgProjectOrderStatusReportRepository(database)
            : new UnavailableProjectOrderStatusReportRepository(),
      }),
      inject: [DatabaseService],
    },
    {
      provide: ProjectOrderCreatedMonthCountsReportService,
      useFactory: (database: DatabaseService) =>
        new ProjectOrderCreatedMonthCountsReportService({
          reports: database.isConfigured
            ? new PgProjectOrderCreatedMonthCountsReportRepository(database)
            : new UnavailableProjectOrderCreatedMonthCountsReportRepository(),
        }),
      inject: [DatabaseService],
    },
    {
      provide: ProjectOrderRelationCountsReportService,
      useFactory: (database: DatabaseService) =>
        new ProjectOrderRelationCountsReportService({
          reports: database.isConfigured
            ? new PgProjectOrderRelationCountsReportRepository(database)
            : new UnavailableProjectOrderRelationCountsReportRepository(),
        }),
      inject: [DatabaseService],
    },
  ],
})
export class ProjectsModule {}
