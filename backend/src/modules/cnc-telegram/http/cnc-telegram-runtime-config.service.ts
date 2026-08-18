import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BackendEnv } from '../../../config/env.validation';

export interface CncTelegramFeatureFlags {
  cncTelegramEnabled: boolean;
  backgroundIngestEnabled: boolean;
}

@Injectable()
export class CncTelegramRuntimeConfigService {
  constructor(@Inject(ConfigService) private readonly config: ConfigService<BackendEnv, true>) {}

  getFeatureFlags(): CncTelegramFeatureFlags {
    return {
      cncTelegramEnabled: this.config.get('BACKEND_ENABLE_CNC_TELEGRAM', { infer: true }),
      backgroundIngestEnabled: this.config.get('CNC_TELEGRAM_BACKGROUND_INGEST_ENABLED', { infer: true }),
    };
  }
}
