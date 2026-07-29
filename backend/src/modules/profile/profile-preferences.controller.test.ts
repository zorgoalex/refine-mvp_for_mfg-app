import { describe, expect, it } from 'vitest';
import { ApiError } from '../../common/errors/api-error';
import type { CurrentUser } from '../../permissions/current-user';
import { getPermissionsForRole } from '../../permissions/permissions';
import {
  parseReferenceUsageRequest,
  parseUpdateUserPreferencesRequest,
  ProfilePreferencesController,
} from './profile-preferences.controller';
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
        return { themeMode: 'light', uiSize: 'default', uiVariant: 'legacy', orderDetailColumns: {}, recentReferences: {}, pageSizePreferences: {} };
      },
      async update(command) {
        calls.push(`update:${command.currentUser.id}:${command.preferences.themeMode}:${Object.keys(command.preferences.orderDetailColumns ?? {}).join(',')}`);
        return { themeMode: 'dark', uiSize: 'default', uiVariant: command.preferences.uiVariant ?? 'legacy', orderDetailColumns: command.preferences.orderDetailColumns ?? {}, recentReferences: {}, pageSizePreferences: command.preferences.pageSizePreferences ?? {} };
      },
      async promoteReferenceUsage(command) {
        calls.push(`promote:${command.currentUser.id}:${command.resource}:${command.entityId}`);
        return {
          themeMode: 'dark',
          uiSize: 'default',
          uiVariant: 'legacy',
          orderDetailColumns: {},
          recentReferences: { [command.resource]: [command.entityId] },
          pageSizePreferences: {},
        };
      },
    });

    await expect(controller.get({ user: currentUser('15') })).resolves.toEqual({
      preferences: { themeMode: 'light', uiSize: 'default', uiVariant: 'legacy', orderDetailColumns: {}, recentReferences: {}, pageSizePreferences: {} },
    });
    await expect(controller.update({ user: currentUser('15') }, {
      themeMode: 'dark',
      orderDetailColumns: { orderEdit: { order: ['detail_number'], hidden: [] } },
    })).resolves.toEqual({
      preferences: { themeMode: 'dark', uiSize: 'default', uiVariant: 'legacy', orderDetailColumns: { orderEdit: { order: ['detail_number'], hidden: [] } }, recentReferences: {}, pageSizePreferences: {} },
    });
    await expect(controller.promoteReferenceUsage(
      { user: currentUser('15') },
      { resource: 'sheet_material_types', entityId: 27 },
    )).resolves.toEqual({
      preferences: {
        themeMode: 'dark',
        uiSize: 'default',
        uiVariant: 'legacy',
        orderDetailColumns: {},
        recentReferences: { sheet_material_types: [27] },
        pageSizePreferences: {},
      },
    });
    expect(calls).toEqual([
      'get:15',
      'update:15:dark:orderEdit',
      'promote:15:sheet_material_types:27',
    ]);
  });

  it('strictly validates reference usage without accepting an owner id', () => {
    expect(parseReferenceUsageRequest({
      resource: 'sheet_material_types',
      entityId: 11,
    })).toEqual({
      resource: 'sheet_material_types',
      entityId: 11,
    });
    expect(() => parseReferenceUsageRequest({
      resource: 'unknown',
      entityId: 11,
    })).toThrow(ApiError);
    expect(() => parseReferenceUsageRequest({
      resource: 'sheet_material_types',
      entityId: 0,
    })).toThrow(ApiError);
    expect(() => parseReferenceUsageRequest({
      resource: 'sheet_material_types',
      entityId: 11,
      userId: 99,
    })).toThrow(ApiError);
  });

  it('validates update body', () => {
    expect(parseUpdateUserPreferencesRequest({ themeMode: 'dark' })).toEqual({ themeMode: 'dark' });
    expect(parseUpdateUserPreferencesRequest({ uiSize: 'small' })).toEqual({ uiSize: 'small' });
    expect(parseUpdateUserPreferencesRequest({ uiSize: 'default' })).toEqual({ uiSize: 'default' });
    expect(parseUpdateUserPreferencesRequest({ uiVariant: 'legacy' })).toEqual({ uiVariant: 'legacy' });
    expect(parseUpdateUserPreferencesRequest({ uiVariant: 'evolution' })).toEqual({ uiVariant: 'evolution' });
    expect(parseUpdateUserPreferencesRequest({ uiVariant: 'line' })).toEqual({ uiVariant: 'line' });
    expect(parseUpdateUserPreferencesRequest({ uiVariant: 'air' })).toEqual({ uiVariant: 'air' });
    expect(parseUpdateUserPreferencesRequest({ pageSizePreferences: { 'refine:orders_view': 50 } }))
      .toEqual({ pageSizePreferences: { 'refine:orders_view': 50 } });
    expect(() => parseUpdateUserPreferencesRequest({ uiSize: 'huge' })).toThrowError();
    expect(() => parseUpdateUserPreferencesRequest({ uiVariant: 'future' })).toThrow(ApiError);
    expect(() => parseUpdateUserPreferencesRequest({ pageSizePreferences: { audit: 200 } })).toThrow(ApiError);
    expect(() => parseUpdateUserPreferencesRequest({
      pageSizePreferences: Object.fromEntries(
        Array.from({ length: 33 }, (_, index) => [`list:${index}`, 20]),
      ),
    })).toThrow(ApiError);
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
    async promoteReferenceUsage() {
      throw new Error('promoteReferenceUsage should not be called');
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
