import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { DatabaseService } from '../../database/database.service';
import { PermissionsModule } from '../../permissions/permissions.module';
import { PgGroupRepository, UnavailableGroupRepository } from './group.repository';
import { GroupsController } from './groups.controller';
import { GroupsRuntimeConfigService } from './groups-runtime-config.service';
import { GroupsService } from './groups.service';
import { GroupOverviewController } from './overview/group-overview.controller';
import { PgGroupOverviewRepository, UnavailableGroupOverviewRepository } from './overview/group-overview.repository';
import { GroupOverviewService } from './overview/group-overview.service';
import { GroupEntityLinksController } from './entity-links/group-entity-links.controller';
import {
  PgGroupEntityLinksRepository,
  UnavailableGroupEntityLinksRepository,
} from './entity-links/group-entity-links.repository';
import { GroupEntityLinksService } from './entity-links/group-entity-links.service';
import { GroupBatchLinkController } from './batch-link/group-batch-link.controller';
import {
  PgGroupBatchLinkRepository,
  UnavailableGroupBatchLinkRepository,
} from './batch-link/group-batch-link.repository';
import { GroupBatchLinkService } from './batch-link/group-batch-link.service';
import { GroupParticipantsController } from './participants/group-participants.controller';
import {
  PgGroupParticipantsRepository,
  UnavailableGroupParticipantsRepository,
} from './participants/group-participants.repository';
import { GroupParticipantsService } from './participants/group-participants.service';
import { GroupNotificationService } from './notifications/group-notification.service';
import {
  PgGroupNotificationRecipientRepository,
  UnavailableGroupNotificationRecipientRepository,
} from './notifications/group-notification-recipient.repository';
import {
  PgGroupNotificationRepository,
  UnavailableGroupNotificationRepository,
} from './notifications/group-notification.repository';
import { GroupOrderReportController } from './reporting/group-order-report.controller';
import {
  PgGroupOrderReportRepository,
  UnavailableGroupOrderReportRepository,
} from './reporting/group-order-report.repository';
import { GroupOrderReportService } from './reporting/group-order-report.service';
import { GroupOrderRelationCountsReportController } from './reporting/group-order-relation-counts-report.controller';
import {
  PgGroupOrderRelationCountsReportRepository,
  UnavailableGroupOrderRelationCountsReportRepository,
} from './reporting/group-order-relation-counts-report.repository';
import { GroupOrderRelationCountsReportService } from './reporting/group-order-relation-counts-report.service';
import { GroupOrderCreatedMonthCountsReportController } from './reporting/group-order-created-month-counts-report.controller';
import {
  PgGroupOrderCreatedMonthCountsReportRepository,
  UnavailableGroupOrderCreatedMonthCountsReportRepository,
} from './reporting/group-order-created-month-counts-report.repository';
import { GroupOrderCreatedMonthCountsReportService } from './reporting/group-order-created-month-counts-report.service';
import { GroupOrderStatusReportController } from './reporting/group-order-status-report.controller';
import {
  PgGroupOrderStatusReportRepository,
  UnavailableGroupOrderStatusReportRepository,
} from './reporting/group-order-status-report.repository';
import { GroupOrderStatusReportService } from './reporting/group-order-status-report.service';
import { GroupProductionStatusCountsReportController } from './reporting/group-production-status-counts-report.controller';
import {
  PgGroupProductionStatusCountsReportRepository,
  UnavailableGroupProductionStatusCountsReportRepository,
} from './reporting/group-production-status-counts-report.repository';
import { GroupProductionStatusCountsReportService } from './reporting/group-production-status-counts-report.service';
import { GroupDeadlineStatusCountsReportController } from './reporting/group-deadline-status-counts-report.controller';
import {
  PgGroupDeadlineStatusCountsReportRepository,
  UnavailableGroupDeadlineStatusCountsReportRepository,
} from './reporting/group-deadline-status-counts-report.repository';
import { GroupDeadlineStatusCountsReportService } from './reporting/group-deadline-status-counts-report.service';

@Module({
  imports: [DatabaseModule, PermissionsModule],
  controllers: [
    GroupsController,
    GroupOrderReportController,
    GroupOrderStatusReportController,
    GroupProductionStatusCountsReportController,
    GroupDeadlineStatusCountsReportController,
    GroupOrderRelationCountsReportController,
    GroupOrderCreatedMonthCountsReportController,
    GroupOverviewController,
    GroupEntityLinksController,
    GroupBatchLinkController,
    GroupParticipantsController,
  ],
  providers: [
    GroupsRuntimeConfigService,
    {
      provide: GroupsService,
      useFactory: (database: DatabaseService) =>
        new GroupsService({
          groups: database.isConfigured
            ? new PgGroupRepository(database)
            : new UnavailableGroupRepository(),
        }),
      inject: [DatabaseService],
    },
    {
      provide: GroupOrderReportService,
      useFactory: (database: DatabaseService) =>
        new GroupOrderReportService({
          reports: database.isConfigured
            ? new PgGroupOrderReportRepository(database)
            : new UnavailableGroupOrderReportRepository(),
      }),
      inject: [DatabaseService],
    },
    {
      provide: GroupOrderStatusReportService,
      useFactory: (database: DatabaseService) =>
        new GroupOrderStatusReportService({
          reports: database.isConfigured
            ? new PgGroupOrderStatusReportRepository(database)
            : new UnavailableGroupOrderStatusReportRepository(),
      }),
      inject: [DatabaseService],
    },
    {
      provide: GroupProductionStatusCountsReportService,
      useFactory: (database: DatabaseService) =>
        new GroupProductionStatusCountsReportService({
          reports: database.isConfigured
            ? new PgGroupProductionStatusCountsReportRepository(database)
            : new UnavailableGroupProductionStatusCountsReportRepository(),
        }),
      inject: [DatabaseService],
    },
    {
      provide: GroupOrderCreatedMonthCountsReportService,
      useFactory: (database: DatabaseService) =>
        new GroupOrderCreatedMonthCountsReportService({
          reports: database.isConfigured
            ? new PgGroupOrderCreatedMonthCountsReportRepository(database)
            : new UnavailableGroupOrderCreatedMonthCountsReportRepository(),
        }),
      inject: [DatabaseService],
    },
    {
      provide: GroupOrderRelationCountsReportService,
      useFactory: (database: DatabaseService) =>
        new GroupOrderRelationCountsReportService({
          reports: database.isConfigured
            ? new PgGroupOrderRelationCountsReportRepository(database)
            : new UnavailableGroupOrderRelationCountsReportRepository(),
        }),
      inject: [DatabaseService],
    },
    {
      provide: GroupOverviewService,
      useFactory: (database: DatabaseService) =>
        new GroupOverviewService({
          overviews: database.isConfigured
            ? new PgGroupOverviewRepository(database)
            : new UnavailableGroupOverviewRepository(),
      }),
      inject: [DatabaseService],
    },
    {
      provide: GroupDeadlineStatusCountsReportService,
      useFactory: (database: DatabaseService) =>
        new GroupDeadlineStatusCountsReportService({
          reports: database.isConfigured
            ? new PgGroupDeadlineStatusCountsReportRepository(database)
            : new UnavailableGroupDeadlineStatusCountsReportRepository(),
        }),
      inject: [DatabaseService],
    },
    {
      provide: GroupEntityLinksService,
      useFactory: (database: DatabaseService) =>
        new GroupEntityLinksService({
          links: database.isConfigured
            ? new PgGroupEntityLinksRepository(database)
            : new UnavailableGroupEntityLinksRepository(),
        }),
      inject: [DatabaseService],
    },
    {
      provide: GroupBatchLinkService,
      useFactory: (database: DatabaseService) =>
        new GroupBatchLinkService({
          batchLinks: database.isConfigured
            ? new PgGroupBatchLinkRepository(database)
            : new UnavailableGroupBatchLinkRepository(),
          entityLinks: database.isConfigured
            ? new PgGroupEntityLinksRepository(database)
            : new UnavailableGroupEntityLinksRepository(),
          database,
        }),
      inject: [DatabaseService],
    },
    {
      provide: GroupParticipantsService,
      useFactory: (
        database: DatabaseService,
        notifications: GroupNotificationService,
        runtimeConfig: GroupsRuntimeConfigService,
      ) =>
        new GroupParticipantsService({
          participants: database.isConfigured
            ? new PgGroupParticipantsRepository(database)
            : new UnavailableGroupParticipantsRepository(),
          notifications,
          groupP8NotificationsEnabled: runtimeConfig.getFeatureFlags().groupP8NotificationsEnabled,
      }),
      inject: [DatabaseService, GroupNotificationService, GroupsRuntimeConfigService],
    },
    {
      provide: PgGroupNotificationRecipientRepository,
      useFactory: (database: DatabaseService) =>
        database.isConfigured
          ? new PgGroupNotificationRecipientRepository(database)
          : new UnavailableGroupNotificationRecipientRepository(),
      inject: [DatabaseService],
    },
    {
      provide: PgGroupNotificationRepository,
      useFactory: (database: DatabaseService) =>
        database.isConfigured
          ? new PgGroupNotificationRepository(database)
          : new UnavailableGroupNotificationRepository(),
      inject: [DatabaseService],
    },
    {
      provide: GroupNotificationService,
      useFactory: (
        recipients: PgGroupNotificationRecipientRepository,
        notifications: PgGroupNotificationRepository,
      ) =>
        new GroupNotificationService({
          recipients,
          notifications,
        }),
      inject: [PgGroupNotificationRecipientRepository, PgGroupNotificationRepository],
    },
  ],
  exports: [
    GroupsRuntimeConfigService,
    GroupNotificationService,
  ],
})
export class GroupsModule {}
