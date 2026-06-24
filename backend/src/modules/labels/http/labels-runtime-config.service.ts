import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BackendEnv } from '../../../config/env.validation';

export interface LabelsHttpFeatureFlags {
  labelsEnabled: boolean;
}

@Injectable()
export class LabelsRuntimeConfigService {
  constructor(@Inject(ConfigService) private readonly config: ConfigService<BackendEnv, true>) {}

  getFeatureFlags(): LabelsHttpFeatureFlags {
    return {
      labelsEnabled: this.config.get('BACKEND_ENABLE_LABELS', { infer: true }),
    };
  }
}
