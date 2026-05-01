import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnvForNest } from './config/env.validation';
import { AuthModule } from './modules/auth/auth.module';
import { DeadlinesModule } from './modules/deadlines/deadlines.module';
import { HealthModule } from './modules/health/health.module';
import { OrdersModule } from './modules/orders/orders.module';
import { UsersModule } from './modules/users/users.module';
import { VlmModule } from './modules/vlm/vlm.module';
import { PermissionsModule } from './permissions/permissions.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      validate: validateEnvForNest,
    }),
    AuthModule,
    DeadlinesModule,
    HealthModule,
    OrdersModule,
    UsersModule,
    VlmModule,
    PermissionsModule,
  ],
})
export class AppModule {}
