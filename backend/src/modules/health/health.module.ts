import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { RateLimitModule } from '../../rate-limit/rate-limit.module';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

@Module({
  imports: [DatabaseModule, RateLimitModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
