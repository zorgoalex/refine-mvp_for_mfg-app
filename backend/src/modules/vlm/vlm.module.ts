import { Module } from '@nestjs/common';
import { UnavailableVlmProvider } from './adapters/unavailable-vlm-provider';
import { VlmService } from './application/vlm.service';
import { VlmController } from './http/vlm.controller';
import { VlmRuntimeConfigService } from './http/vlm-runtime-config.service';

@Module({
  controllers: [VlmController],
  providers: [
    VlmRuntimeConfigService,
    {
      provide: VlmService,
      useFactory: () =>
        new VlmService({
          provider: new UnavailableVlmProvider(),
        }),
    },
  ],
})
export class VlmModule {}
