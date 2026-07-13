import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BackendEnv } from '../../../config/env.validation';

export interface CutHttpFeatureFlags {
  cutEnabled: boolean;
  cutReadOnly: boolean;
  cutAutoTrigger: boolean;
}

@Injectable()
export class CutRuntimeConfigService {
  constructor(@Inject(ConfigService) private readonly config: ConfigService<BackendEnv, true>) {}

  getFeatureFlags(): CutHttpFeatureFlags {
    return {
      cutEnabled: this.config.get('BACKEND_ENABLE_CUT_JOBS', { infer: true }),
      cutReadOnly: this.config.get('BACKEND_CUT_JOBS_READ_ONLY', { infer: true }),
      cutAutoTrigger: this.config.get('BACKEND_CUT_AUTO_TRIGGER', { infer: true }),
    };
  }

  getFreecutBaseUrl(): string | undefined {
    return this.config.get('FREECUT_BASE_URL', { infer: true });
  }

  getFreecutTimeoutMs(): number {
    return this.config.get('FREECUT_OPTIMIZE_TIMEOUT_MS', { infer: true });
  }

  getHeuristicAutoThresholdInstances(): number {
    return this.config.get('BACKEND_CUT_HEURISTIC_AUTO_THRESHOLD', { infer: true });
  }

  isNativePortraitWriterEnabled(): boolean {
    return this.config.get('BACKEND_CUT_NATIVE_PORTRAIT', { infer: true });
  }
}
