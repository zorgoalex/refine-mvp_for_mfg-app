import { Module } from '@nestjs/common';
import { BazisRuntimeConfigService } from './http/bazis-runtime-config.service';

@Module({
  providers: [BazisRuntimeConfigService],
  exports: [BazisRuntimeConfigService],
})
export class BazisModule {}
