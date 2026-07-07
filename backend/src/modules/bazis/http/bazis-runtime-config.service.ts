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
    const raw = this.config.get<string>('BACKEND_ENABLE_BAZIS' as never) ?? 'false';
    return {
      bazisEnabled: ['true', '1', 'yes', 'on'].includes(raw.toLowerCase()),
    };
  }
}
