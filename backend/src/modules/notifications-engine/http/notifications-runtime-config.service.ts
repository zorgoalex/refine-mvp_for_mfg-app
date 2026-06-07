import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BackendEnv } from '../../../config/env.validation';

export interface NotificationsFeatureFlags {
  engineEnabled: boolean;
  rulesReadOnly: boolean;
}

@Injectable()
export class NotificationsRuntimeConfigService {
  constructor(@Inject(ConfigService) private readonly config: ConfigService<BackendEnv, true>) {}

  getFeatureFlags(): NotificationsFeatureFlags {
    return {
      engineEnabled: this.config.get('BACKEND_ENABLE_NOTIFICATION_ENGINE', { infer: true }),
      rulesReadOnly: this.config.get('BACKEND_NOTIFICATION_RULES_READ_ONLY', { infer: true }),
    };
  }

  isEngineEnabled(): boolean {
    return this.getFeatureFlags().engineEnabled;
  }

  isRulesReadOnly(): boolean {
    return this.getFeatureFlags().rulesReadOnly;
  }
}
