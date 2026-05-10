import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BackendEnv } from '../../../config/env.validation';

export interface PaymentsHttpFeatureFlags {
  paymentsEnabled: boolean;
}

@Injectable()
export class PaymentsRuntimeConfigService {
  constructor(@Inject(ConfigService) private readonly config: ConfigService<BackendEnv, true>) {}

  getFeatureFlags(): PaymentsHttpFeatureFlags {
    return {
      paymentsEnabled: this.config.get('BACKEND_ENABLE_PAYMENTS', { infer: true }),
    };
  }
}

