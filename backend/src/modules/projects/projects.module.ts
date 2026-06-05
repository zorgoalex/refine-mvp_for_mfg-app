import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { DatabaseService } from '../../database/database.service';
import { PermissionsModule } from '../../permissions/permissions.module';
import { PgProjectRepository, UnavailableProjectRepository } from './project.repository';
import { ProjectsController } from './projects.controller';
import { ProjectsRuntimeConfigService } from './projects-runtime-config.service';
import { ProjectsService } from './projects.service';
import { ProjectOverviewController } from './overview/project-overview.controller';
import { PgProjectOverviewRepository, UnavailableProjectOverviewRepository } from './overview/project-overview.repository';
import { ProjectOverviewService } from './overview/project-overview.service';
import { ProjectEntityLinksController } from './entity-links/project-entity-links.controller';
import {
  PgProjectEntityLinksRepository,
  UnavailableProjectEntityLinksRepository,
} from './entity-links/project-entity-links.repository';
import { ProjectEntityLinksService } from './entity-links/project-entity-links.service';
import { ProjectParticipantsController } from './participants/project-participants.controller';
import {
  PgProjectParticipantsRepository,
  UnavailableProjectParticipantsRepository,
} from './participants/project-participants.repository';
import { ProjectParticipantsService } from './participants/project-participants.service';
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
import { ProjectProductionStatusCountsReportController } from './reporting/project-production-status-counts-report.controller';
import {
  PgProjectProductionStatusCountsReportRepository,
  UnavailableProjectProductionStatusCountsReportRepository,
} from './reporting/project-production-status-counts-report.repository';
import { ProjectProductionStatusCountsReportService } from './reporting/project-production-status-counts-report.service';

@Module({
  imports: [DatabaseModule, PermissionsModule],
  controllers: [
    ProjectsController,
    ProjectOrderReportController,
    ProjectOrderStatusReportController,
    ProjectProductionStatusCountsReportController,
    ProjectOrderRelationCountsReportController,
    ProjectOrderCreatedMonthCountsReportController,
    ProjectOverviewController,
    ProjectEntityLinksController,
    ProjectParticipantsController,
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
      provide: ProjectProductionStatusCountsReportService,
      useFactory: (database: DatabaseService) =>
        new ProjectProductionStatusCountsReportService({
          reports: database.isConfigured
            ? new PgProjectProductionStatusCountsReportRepository(database)
            : new UnavailableProjectProductionStatusCountsReportRepository(),
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
    {
      provide: ProjectOverviewService,
      useFactory: (database: DatabaseService) =>
        new ProjectOverviewService({
          overviews: database.isConfigured
            ? new PgProjectOverviewRepository(database)
            : new UnavailableProjectOverviewRepository(),
      }),
      inject: [DatabaseService],
    },
    {
      provide: ProjectEntityLinksService,
      useFactory: (database: DatabaseService) =>
        new ProjectEntityLinksService({
          links: database.isConfigured
            ? new PgProjectEntityLinksRepository(database)
            : new UnavailableProjectEntityLinksRepository(),
        }),
      inject: [DatabaseService],
    },
    {
      provide: ProjectParticipantsService,
      useFactory: (database: DatabaseService) =>
        new ProjectParticipantsService({
          participants: database.isConfigured
            ? new PgProjectParticipantsRepository(database)
            : new UnavailableProjectParticipantsRepository(),
        }),
      inject: [DatabaseService],
    },
  ],
})
export class ProjectsModule {}
