import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BackendEnv } from '../../../config/env.validation';

export interface DowelingHttpFeatureFlags {
  dowelingCommandsEnabled: boolean;
}

@Injectable()
export class DowelingRuntimeConfigService {
  constructor(@Inject(ConfigService) private readonly config: ConfigService<BackendEnv, true>) {}

  getFeatureFlags(): DowelingHttpFeatureFlags {
    return {
      dowelingCommandsEnabled: this.config.get('BACKEND_ENABLE_DOWELING_COMMANDS', { infer: true }),
    };
  }
}
