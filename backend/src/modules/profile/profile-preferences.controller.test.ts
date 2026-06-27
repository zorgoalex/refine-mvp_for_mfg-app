import { describe, expect, it } from 'vitest';
import { ApiError } from '../../common/errors/api-error';
import type { CurrentUser } from '../../permissions/current-user';
import { getPermissionsForRole } from '../../permissions/permissions';
import { parseUpdateUserPreferencesRequest, ProfilePreferencesController } from './profile-preferences.controller';
import type { ProfilePreferencesService } from './profile-preferences.service';

describe('ProfilePreferencesController', () => {
  it('requires authenticated current user', async () => {
    const controller = createController();

    await expect(controller.get({})).rejects.toMatchObject({
      statusCode: 401,
      code: 'AUTH_REQUIRED',
    } satisfies Partial<ApiError>);
  });

  it('delegates get and update for current user', async () => {
    const calls: string[] = [];
    const controller = createController({
      async get(command) {
        calls.push(`get:${command.currentUser.id}`);
        return { themeMode: 'light' };
      },
      async update(command) {
        calls.push(`update:${command.currentUser.id}:${command.preferences.themeMode}`);
        return { themeMode: 'dark' };
      },
    });

    await expect(controller.get({ user: currentUser('15') })).resolves.toEqual({
      preferences: { themeMode: 'light' },
    });
    await expect(controller.update({ user: currentUser('15') }, { themeMode: 'dark' })).resolves.toEqual({
      preferences: { themeMode: 'dark' },
    });
    expect(calls).toEqual(['get:15', 'update:15:dark']);
  });

  it('validates update body', () => {
    expect(parseUpdateUserPreferencesRequest({ themeMode: 'dark' })).toEqual({ themeMode: 'dark' });
    expect(parseUpdateUserPreferencesRequest({})).toEqual({});
    expect(() => parseUpdateUserPreferencesRequest({ themeMode: 'system' })).toThrow(ApiError);
    expect(() => parseUpdateUserPreferencesRequest(null)).toThrow(ApiError);
  });
});

function createController(service?: Partial<ProfilePreferencesService>): ProfilePreferencesController {
  return new ProfilePreferencesController({
    async get() {
      throw new Error('get should not be called');
    },
    async update() {
      throw new Error('update should not be called');
    },
    ...service,
  } as ProfilePreferencesService);
}

function currentUser(id: string): CurrentUser {
  return {
    id,
    username: `user-${id}`,
    role: 'manager',
    roleId: 10,
    permissions: getPermissionsForRole('manager'),
  };
}
