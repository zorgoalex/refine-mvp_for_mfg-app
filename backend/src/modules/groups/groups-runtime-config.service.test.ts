import { describe, expect, it } from 'vitest';
import { GroupsRuntimeConfigService } from './groups-runtime-config.service';

describe('GroupsRuntimeConfigService', () => {
  it('exposes the default-off P8 notification gate', () => {
    const service = new GroupsRuntimeConfigService(config({
      BACKEND_ENABLE_GROUPS: true,
      BACKEND_GROUPS_READ_ONLY: false,
      BACKEND_ENABLE_GROUP_P8_NOTIFICATIONS: true,
      BACKEND_ENABLE_GROUPS_BATCH_LINK_WRITE: false,
    }));

    expect(service.getFeatureFlags()).toEqual({
      groupsEnabled: true,
      groupsReadOnly: false,
      groupP8NotificationsEnabled: true,
      groupsBatchLinkWriteEnabled: false,
    });
  });
});

function config(values: Record<string, unknown>) {
  return {
    get(key: string) {
      return values[key];
    },
  } as never;
}
