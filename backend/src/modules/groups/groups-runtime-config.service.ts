import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BackendEnv } from '../../config/env.validation';

export interface GroupsHttpFeatureFlags {
  groupsEnabled: boolean;
  groupsReadOnly: boolean;
  groupP8NotificationsEnabled: boolean;
  groupsBatchLinkWriteEnabled: boolean;
}

type GroupsRuntimeBooleanFlagKey =
  | 'BACKEND_ENABLE_GROUPS'
  | 'BACKEND_GROUPS_READ_ONLY'
  | 'BACKEND_ENABLE_GROUP_P8_NOTIFICATIONS'
  | 'BACKEND_ENABLE_GROUPS_BATCH_LINK_WRITE';

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

  private getBooleanFlag(key: GroupsRuntimeBooleanFlagKey): boolean {
    return this.config.get(key, { infer: true });
  }
}
