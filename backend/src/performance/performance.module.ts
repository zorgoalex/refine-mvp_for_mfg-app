import { Module } from '@nestjs/common';
import { PerformanceController } from './performance.controller';
import { PerformanceQueryTelemetryService } from './performance-query-telemetry.service';
import { PerformanceRumService } from './performance-rum.service';

@Module({
  controllers: [PerformanceController],
  providers: [PerformanceQueryTelemetryService, PerformanceRumService],
  exports: [PerformanceQueryTelemetryService],
})
export class PerformanceModule {}
