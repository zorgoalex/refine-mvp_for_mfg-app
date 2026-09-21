import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { PermissionsModule } from '../../permissions/permissions.module';
import { InboundSignalsController } from './inbound-signals.controller';
import { InboundSignalsService } from './inbound-signals.service';
@Module({ imports: [DatabaseModule, PermissionsModule], controllers: [InboundSignalsController],
  providers: [InboundSignalsService], exports: [InboundSignalsService] })
export class InboundSignalsModule {}
