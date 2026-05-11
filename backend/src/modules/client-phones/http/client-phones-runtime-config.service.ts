import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BackendEnv } from '../../../config/env.validation';

export interface ClientPhonesHttpFeatureFlags {
  clientPhonesEnabled: boolean;
}

@Injectable()
export class ClientPhonesRuntimeConfigService {
  constructor(@Inject(ConfigService) private readonly config: ConfigService<BackendEnv, true>) {}

  getFeatureFlags(): ClientPhonesHttpFeatureFlags {
    return {
      clientPhonesEnabled: this.config.get('BACKEND_ENABLE_CLIENT_PHONES', { infer: true }),
    };
  }
}
