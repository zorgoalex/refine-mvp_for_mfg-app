import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { PgOrderRealtimeReader } from './adapters/pg-order-realtime-reader';
import { PgOrderRealtimeWriter } from './adapters/pg-order-realtime-writer';
import { OrderRealtimeRuntimeConfigService } from './application/order-realtime-runtime-config.service';
import { OrderRealtimeSnapshotService } from './application/order-realtime-snapshot.service';
import { OrderRealtimeStreamService } from './application/order-realtime-stream.service';
import { OrderRealtimeController } from './http/order-realtime.controller';

@Module({
  imports: [DatabaseModule],
  controllers: [OrderRealtimeController],
  providers: [
    PgOrderRealtimeReader,
    PgOrderRealtimeWriter,
    OrderRealtimeRuntimeConfigService,
    OrderRealtimeSnapshotService,
    OrderRealtimeStreamService,
  ],
  exports: [PgOrderRealtimeWriter, OrderRealtimeRuntimeConfigService, OrderRealtimeStreamService],
})
export class OrderRealtimeModule {}
