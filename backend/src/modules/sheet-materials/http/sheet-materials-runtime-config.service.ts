import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BackendEnv } from '../../../config/env.validation';

export interface SheetMaterialsHttpFeatureFlags {
  sheetMaterialsEnabled: boolean;
}

@Injectable()
export class SheetMaterialsRuntimeConfigService {
  constructor(@Inject(ConfigService) private readonly config: ConfigService<BackendEnv, true>) {}

  getFeatureFlags(): SheetMaterialsHttpFeatureFlags {
    return {
      sheetMaterialsEnabled: this.config.get('BACKEND_ENABLE_SHEET_MATERIALS', { infer: true }),
    };
  }
}
