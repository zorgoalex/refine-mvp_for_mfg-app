import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BackendEnv } from '../../../config/env.validation';

export interface UsersHttpFeatureFlags {
  usersEnabled: boolean;
}

@Injectable()
export class UsersRuntimeConfigService {
  constructor(private readonly config: ConfigService<BackendEnv, true>) {}

  getFeatureFlags(): UsersHttpFeatureFlags {
    return {
      usersEnabled: this.config.get('BACKEND_ENABLE_USERS', { infer: true }),
    };
  }
}
