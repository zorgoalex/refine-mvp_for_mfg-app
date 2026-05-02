import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BackendEnv } from '../../../config/env.validation';

export interface AuthHttpFeatureFlags {
  authEnabled: boolean;
  apiPrefix: string;
  nodeEnv: string;
  refreshTokenTtlDays: number;
}

@Injectable()
export class AuthRuntimeConfigService {
  constructor(@Inject(ConfigService) private readonly config: ConfigService<BackendEnv, true>) {}

  getFeatureFlags(): AuthHttpFeatureFlags {
    return {
      authEnabled: this.config.get('BACKEND_ENABLE_AUTH', { infer: true }),
      apiPrefix: this.config.get('API_PREFIX', { infer: true }),
      nodeEnv: this.config.get('NODE_ENV', { infer: true }),
      refreshTokenTtlDays: 7,
    };
  }
}
