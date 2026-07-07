import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BackendEnv } from '../../../config/env.validation';

export interface BazisHttpFeatureFlags {
  bazisEnabled: boolean;
}

@Injectable()
export class BazisRuntimeConfigService {
  constructor(@Inject(ConfigService) private readonly config: ConfigService<BackendEnv, true>) {}

  getFeatureFlags(): BazisHttpFeatureFlags {
    return {
      bazisEnabled: this.config.get('BACKEND_ENABLE_BAZIS', { infer: true }),
    };
  }
}
