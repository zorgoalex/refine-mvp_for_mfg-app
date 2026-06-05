import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BackendEnv } from '../../config/env.validation';

export interface ProjectsHttpFeatureFlags {
  projectsEnabled: boolean;
  projectsReadOnly: boolean;
  projectP8NotificationsEnabled: boolean;
}

@Injectable()
export class ProjectsRuntimeConfigService {
  constructor(@Inject(ConfigService) private readonly config: ConfigService<BackendEnv, true>) {}

  getFeatureFlags(): ProjectsHttpFeatureFlags {
    return {
      projectsEnabled: this.config.get('BACKEND_ENABLE_PROJECTS', { infer: true }),
      projectsReadOnly: this.config.get('BACKEND_PROJECTS_READ_ONLY', { infer: true }),
      projectP8NotificationsEnabled: this.config.get('BACKEND_ENABLE_PROJECT_P8_NOTIFICATIONS', { infer: true }),
    };
  }
}
