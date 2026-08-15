import { Module } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { PerformanceModule } from '../performance/performance.module';

@Module({
  imports: [PerformanceModule],
  providers: [DatabaseService],
  exports: [DatabaseService],
})
export class DatabaseModule {}
