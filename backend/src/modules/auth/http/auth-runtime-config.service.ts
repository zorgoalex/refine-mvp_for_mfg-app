import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BackendEnv } from '../../../config/env.validation';

export interface AuthHttpFeatureFlags {
  authEnabled: boolean;
  nodeEnv: string;
  refreshTokenTtlDays: number;
}

@Injectable()
export class AuthRuntimeConfigService {
  constructor(private readonly config: ConfigService<BackendEnv, true>) {}

  getFeatureFlags(): AuthHttpFeatureFlags {
    return {
      authEnabled: this.config.get('BACKEND_ENABLE_AUTH', { infer: true }),
      nodeEnv: this.config.get('NODE_ENV', { infer: true }),
      refreshTokenTtlDays: 7,
    };
  }
}
