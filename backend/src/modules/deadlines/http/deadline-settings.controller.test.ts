import { PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import type { DeadlineCommandService } from '../application/deadline-command.service';
import type { DeadlineQueryService } from '../application/deadline-query.service';
import { DEFAULT_DEADLINE_SETTINGS } from '../dto/deadline-settings.dto';
import { DeadlineSettingsController, parseUpdateDeadlineSettingsRequest } from './deadline-settings.controller';
import type { DeadlinesRuntimeConfigService } from './deadlines-runtime-config.service';

describe('DeadlineSettingsController', () => {
  it('uses unversioned controller path so global API_PREFIX publishes /api/v1/deadline-settings', () => {
    expect(Reflect.getMetadata(PATH_METADATA, DeadlineSettingsController)).toBe('deadline-settings');
  });

  it('returns settings while deadlines are enabled in read-only mode', async () => {
    const controller = createController({
      flags: { deadlinesEnabled: true, deadlinesReadOnly: true },
      queries: {
        async getSettings() {
          return { settings: DEFAULT_DEADLINE_SETTINGS };
        },
      },
    });

    await expect(controller.get({ user: currentUser() })).resolves.toEqual({
      settings: DEFAULT_DEADLINE_SETTINGS,
    });
  });

  it('blocks settings update in read-only mode', async () => {
    const controller = createController({
      flags: { deadlinesEnabled: true, deadlinesReadOnly: true },
    });

    await expect(
      controller.update({ user: currentUser() }, { notifyAssigneeEnabled: true }),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: 'DEADLINES_READ_ONLY',
    } satisfies Partial<ApiError>);
  });

  it('validates non-empty boolean settings patch', () => {
    expect(parseUpdateDeadlineSettingsRequest({ notifyAssigneeEnabled: true })).toEqual({
      notifyAssigneeEnabled: true,
    });
    expect(() => parseUpdateDeadlineSettingsRequest({})).toThrow(ApiError);
    expect(() => parseUpdateDeadlineSettingsRequest({ notifyAssigneeEnabled: 'true' })).toThrow(
      ApiError,
    );
  });
});

function createController(options: {
  flags: { deadlinesEnabled: boolean; deadlinesReadOnly: boolean };
  commands?: Partial<DeadlineCommandService>;
  queries?: Partial<DeadlineQueryService>;
}): DeadlineSettingsController {
  const commands = {
    async updateSettings() {
      throw new Error('updateSettings should not be called');
    },
    ...options.commands,
  } as unknown as DeadlineCommandService;
  const queries = {
    async getSettings() {
      throw new Error('getSettings should not be called');
    },
    ...options.queries,
  } as unknown as DeadlineQueryService;
  const runtimeConfig = {
    getFeatureFlags() {
      return {
        ...options.flags,
        deadlineWorkerEnabled: false,
        deadlineActionsEnabled: false,
        deadlineNotificationsEnabled: false,
        deadlineWorkerPollIntervalMs: 60000,
        deadlineWorkerBatchSize: 100,
        deadlineWorkerId: 'backend-local',
      };
    },
  } as DeadlinesRuntimeConfigService;

  return new DeadlineSettingsController(commands, queries, runtimeConfig);
}

function currentUser(): CurrentUser {
  return {
    id: 'admin-id',
    username: 'admin',
    role: 'admin',
    roleId: 1,
    permissions: getPermissionsForRole('admin'),
  };
}
