import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BackendEnv } from '../../../config/env.validation';

export interface ClientPhonesHttpFeatureFlags {
  clientPhonesEnabled: boolean;
  /** Merges of clients are on: a delete must name the client whose phone it removes (a form opened before a merge). */
  ownerRequired: boolean;
}

@Injectable()
export class ClientPhonesRuntimeConfigService {
  constructor(@Inject(ConfigService) private readonly config: ConfigService<BackendEnv, true>) {}

  getFeatureFlags(): ClientPhonesHttpFeatureFlags {
    return {
      clientPhonesEnabled: this.config.get('BACKEND_ENABLE_CLIENT_PHONES', { infer: true }),
      ownerRequired: this.config.get('BACKEND_CLIENT_MERGE', { infer: true }) === true,
    };
  }
}
