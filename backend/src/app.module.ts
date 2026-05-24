import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnvForNest } from './config/env.validation';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './modules/auth/auth.module';
import { DeadlinesModule } from './modules/deadlines/deadlines.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { HealthModule } from './modules/health/health.module';
import { ClientPhonesModule } from './modules/client-phones/client-phones.module';
import { OrdersModule } from './modules/orders/orders.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { ProductionActionsModule } from './modules/production-actions/production-actions.module';
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
    AuthModule,
    ClientPhonesModule,
    DeadlinesModule,
    NotificationsModule,
    HealthModule,
    OrdersModule,
    PaymentsModule,
    ProductionActionsModule,
    UsersModule,
    VlmModule,
    PermissionsModule,
  ],
})
export class AppModule {}
