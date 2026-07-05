import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BackendEnv } from '../../config/env.validation';

export interface GroupsHttpFeatureFlags {
  groupsEnabled: boolean;
  groupsReadOnly: boolean;
  groupP8NotificationsEnabled: boolean;
  groupsBatchLinkWriteEnabled: boolean;
}

@Injectable()
export class GroupsRuntimeConfigService {
  constructor(@Inject(ConfigService) private readonly config: ConfigService<BackendEnv, true>) {}

  getFeatureFlags(): GroupsHttpFeatureFlags {
    return {
      groupsEnabled: this.getBooleanFlag('BACKEND_ENABLE_GROUPS'),
      groupsReadOnly: this.getBooleanFlag('BACKEND_GROUPS_READ_ONLY'),
      groupP8NotificationsEnabled: this.getBooleanFlag('BACKEND_ENABLE_GROUP_P8_NOTIFICATIONS'),
      groupsBatchLinkWriteEnabled: this.getBooleanFlag('BACKEND_ENABLE_GROUPS_BATCH_LINK_WRITE'),
    };
  }

  private getBooleanFlag(key: string): boolean {
    return this.config.get(key as keyof BackendEnv, { infer: true }) as boolean;
  }
}
