import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnvForNest } from './config/env.validation';
import { DatabaseModule } from './database/database.module';
import { AuditModule } from './modules/audit/audit.module';
import { AuthModule } from './modules/auth/auth.module';
import { DeadlinesModule } from './modules/deadlines/deadlines.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { NotificationsEngineModule } from './modules/notifications-engine/notifications-engine.module';
import { StatusAutomationModule } from './modules/status-automation/status-automation.module';
import { HealthModule } from './modules/health/health.module';
import { ClientPhonesModule } from './modules/client-phones/client-phones.module';
import { CncTelegramModule } from './modules/cnc-telegram/cnc-telegram.module';
import { CrmSyncModule } from './modules/crm-sync/crm-sync.module';
import { BazisModule } from './modules/bazis/bazis.module';
import { BazisCutModule } from './modules/bazis-cut/bazis-cut.module';
import { DowelingModule } from './modules/doweling/doweling.module';
import { CutModule } from './modules/cut/cut.module';
import { LabelsModule } from './modules/labels/labels.module';
import { SheetMaterialsModule } from './modules/sheet-materials/sheet-materials.module';
import { OrdersModule } from './modules/orders/orders.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { ProductionActionsModule } from './modules/production-actions/production-actions.module';
import { ProjectsModule } from './modules/projects/projects.module';
import { GroupsModule } from './modules/groups/groups.module';
import { OrgModule } from './modules/org/org.module';
import { ProfileModule } from './modules/profile/profile.module';
import { UsersModule } from './modules/users/users.module';
import { VlmModule } from './modules/vlm/vlm.module';
import { PermissionsModule } from './permissions/permissions.module';
import { RateLimitModule } from './rate-limit/rate-limit.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnvForNest,
    }),
    RateLimitModule,
    DatabaseModule,
    AuditModule,
    AuthModule,
    ClientPhonesModule,
    CncTelegramModule,
    CrmSyncModule,
    BazisModule,
    BazisCutModule,
    DowelingModule,
    CutModule,
    LabelsModule,
    SheetMaterialsModule,
    DeadlinesModule,
    NotificationsModule,
    NotificationsEngineModule,
    StatusAutomationModule,
    HealthModule,
    OrdersModule,
    PaymentsModule,
    ProductionActionsModule,
    ProjectsModule,
    GroupsModule,
    OrgModule,
    ProfileModule,
    UsersModule,
    VlmModule,
    PermissionsModule,
  ],
})
export class AppModule {}
