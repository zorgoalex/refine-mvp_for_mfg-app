import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BackendEnv } from '../../../config/env.validation';

export interface VlmHttpFeatureFlags {
  vlmEnabled: boolean;
  vlmDisabled: boolean;
}

export interface VlmUploadLimits {
  maxUploadBytes: number;
  allowedMimeTypes: readonly string[];
}

@Injectable()
export class VlmRuntimeConfigService {
  constructor(@Inject(ConfigService) private readonly config: ConfigService<BackendEnv, true>) {}

  getFeatureFlags(): VlmHttpFeatureFlags {
    return {
      vlmEnabled: this.config.get('BACKEND_ENABLE_VLM', { infer: true }),
      vlmDisabled: this.config.get('BACKEND_VLM_DISABLED', { infer: true }),
    };
  }

  getUploadLimits(): VlmUploadLimits {
    return {
      maxUploadBytes: this.config.get('VLM_MAX_UPLOAD_MB', { infer: true }) * 1024 * 1024,
      allowedMimeTypes: this.config
        .get('VLM_ALLOWED_MIME_TYPES', { infer: true })
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    };
  }
}
