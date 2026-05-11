import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BackendEnv } from '../../../config/env.validation';

export interface ProductionActionsHttpFeatureFlags {
  productionActionsEnabled: boolean;
}

@Injectable()
export class ProductionActionsRuntimeConfigService {
  constructor(@Inject(ConfigService) private readonly config: ConfigService<BackendEnv, true>) {}

  getFeatureFlags(): ProductionActionsHttpFeatureFlags {
    return {
      productionActionsEnabled: this.config.get('BACKEND_ENABLE_PRODUCTION_ACTIONS', {
        infer: true,
      }),
    };
  }
}
