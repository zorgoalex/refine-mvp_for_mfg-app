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
        return { themeMode: 'light', orderDetailColumns: {} };
      },
      async update(command) {
        calls.push(`update:${command.currentUser.id}:${command.preferences.themeMode}:${Object.keys(command.preferences.orderDetailColumns ?? {}).join(',')}`);
        return { themeMode: 'dark', orderDetailColumns: command.preferences.orderDetailColumns ?? {} };
      },
    });

    await expect(controller.get({ user: currentUser('15') })).resolves.toEqual({
      preferences: { themeMode: 'light', orderDetailColumns: {} },
    });
    await expect(controller.update({ user: currentUser('15') }, {
      themeMode: 'dark',
      orderDetailColumns: { orderEdit: { order: ['detail_number'], hidden: [] } },
    })).resolves.toEqual({
      preferences: { themeMode: 'dark', orderDetailColumns: { orderEdit: { order: ['detail_number'], hidden: [] } } },
    });
    expect(calls).toEqual(['get:15', 'update:15:dark:orderEdit']);
  });

  it('validates update body', () => {
    expect(parseUpdateUserPreferencesRequest({ themeMode: 'dark' })).toEqual({ themeMode: 'dark' });
    expect(parseUpdateUserPreferencesRequest({
      orderDetailColumns: { orderShow: { order: ['detail_number', 'height'], hidden: ['note'] } },
    })).toEqual({
      orderDetailColumns: { orderShow: { order: ['detail_number', 'height'], hidden: ['note'] } },
    });
    expect(parseUpdateUserPreferencesRequest({})).toEqual({});
    expect(() => parseUpdateUserPreferencesRequest({ themeMode: 'system' })).toThrow(ApiError);
    expect(() => parseUpdateUserPreferencesRequest({ orderDetailColumns: { orderShow: { order: [7], hidden: [] } } })).toThrow(ApiError);
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
