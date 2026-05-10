import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnvForNest } from './config/env.validation';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './modules/auth/auth.module';
import { DeadlinesModule } from './modules/deadlines/deadlines.module';
import { HealthModule } from './modules/health/health.module';
import { OrdersModule } from './modules/orders/orders.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { UsersModule } from './modules/users/users.module';
import { VlmModule } from './modules/vlm/vlm.module';
import { PermissionsModule } from './permissions/permissions.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnvForNest,
    }),
    DatabaseModule,
    AuthModule,
    DeadlinesModule,
    HealthModule,
    OrdersModule,
    PaymentsModule,
    UsersModule,
    VlmModule,
    PermissionsModule,
  ],
})
export class AppModule {}
