import { describe, expect, it } from 'vitest';
import { ProjectsRuntimeConfigService } from './projects-runtime-config.service';

describe('ProjectsRuntimeConfigService', () => {
  it('exposes the default-off P8 notification gate', () => {
    const service = new ProjectsRuntimeConfigService(config({
      BACKEND_ENABLE_PROJECTS: true,
      BACKEND_PROJECTS_READ_ONLY: false,
      BACKEND_ENABLE_PROJECT_P8_NOTIFICATIONS: true,
    }));

    expect(service.getFeatureFlags()).toEqual({
      projectsEnabled: true,
      projectsReadOnly: false,
      projectP8NotificationsEnabled: true,
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
