import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { RateLimitModule } from '../../rate-limit/rate-limit.module';
import { OrderRealtimeModule } from '../order-realtime/order-realtime.module';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  imports: [DatabaseModule, RateLimitModule, OrderRealtimeModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
