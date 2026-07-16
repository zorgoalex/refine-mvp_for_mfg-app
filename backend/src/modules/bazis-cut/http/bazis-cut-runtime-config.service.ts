import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BackendEnv } from '../../../config/env.validation';

@Injectable()
export class BazisCutRuntimeConfigService {
  constructor(@Inject(ConfigService) private readonly config: ConfigService<BackendEnv, true>) {}

  isEnabled(): boolean {
    return this.config.get('BACKEND_ENABLE_BAZIS_CUT', { infer: true });
  }
}

