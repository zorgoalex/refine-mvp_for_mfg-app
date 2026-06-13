import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BackendEnv } from '../../config/env.validation';

export interface OrgHttpFeatureFlags {
  orgEnabled: boolean;
  orgReadOnly: boolean;
}

@Injectable()
export class OrgRuntimeConfigService {
  constructor(@Inject(ConfigService) private readonly config: ConfigService<BackendEnv, true>) {}

  getFeatureFlags(): OrgHttpFeatureFlags {
    return {
      orgEnabled: this.config.get('BACKEND_ENABLE_ORG_MANAGEMENT', { infer: true }),
      orgReadOnly: this.config.get('BACKEND_ORG_MANAGEMENT_READ_ONLY', { infer: true }),
    };
  }
}
