import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import type {
  AccessGroupDto,
  AccessGroupsListDto,
  CreateAccessGroupRequest,
  ReplaceAccessGroupMembersRequest,
  ReplaceAccessGroupPermissionsRequest,
  ReplaceUserAccessGroupsRequest,
  UpdateAccessGroupRequest,
  UpdateAccessGroupsSettingsRequest,
  UserAuthorizationSourcesDto,
} from './types/accessGroupsApi.types';

/**
 * «Группы доступа» (access groups plan v6 §4.2). Every change carries an Idempotency-Key — one per user action,
 * repeated while the same request is retried (see createActionKeyStore).
 */
export const accessGroupsApi = {
  list(): Promise<AccessGroupsListDto> {
    return httpClient.get<AccessGroupsListDto>(apiRoutes.accessGroups.list);
  },

  get(groupId: number): Promise<AccessGroupDto> {
    return httpClient.get<AccessGroupDto>(apiRoutes.accessGroups.byId(validId(groupId)));
  },

  create(request: CreateAccessGroupRequest, idempotencyKey: string): Promise<AccessGroupDto> {
    return httpClient.post<AccessGroupDto>(apiRoutes.accessGroups.list, request, keyHeaders(idempotencyKey));
  },

  update(groupId: number, request: UpdateAccessGroupRequest, idempotencyKey: string): Promise<AccessGroupDto> {
    return httpClient.patch<AccessGroupDto>(apiRoutes.accessGroups.byId(validId(groupId)), request, keyHeaders(idempotencyKey));
  },

  replacePermissions(groupId: number, request: ReplaceAccessGroupPermissionsRequest, idempotencyKey: string): Promise<AccessGroupDto> {
    return httpClient.put<AccessGroupDto>(apiRoutes.accessGroups.permissions(validId(groupId)), request, keyHeaders(idempotencyKey));
  },

  replaceMembers(groupId: number, request: ReplaceAccessGroupMembersRequest, idempotencyKey: string): Promise<AccessGroupDto> {
    return httpClient.put<AccessGroupDto>(apiRoutes.accessGroups.members(validId(groupId)), request, keyHeaders(idempotencyKey));
  },

  remove(groupId: number, version: number, idempotencyKey: string): Promise<{ groupId: number; deleted: true }> {
    return httpClient.request<{ groupId: number; deleted: true }>(apiRoutes.accessGroups.byId(validId(groupId)), {
      method: 'DELETE',
      body: JSON.stringify({ version }),
      ...keyHeaders(idempotencyKey),
    });
  },

  updateSettings(request: UpdateAccessGroupsSettingsRequest, idempotencyKey: string): Promise<AccessGroupsListDto> {
    return httpClient.put<AccessGroupsListDto>(apiRoutes.accessGroups.settings, request, keyHeaders(idempotencyKey));
  },

  userAuthorization(userId: number): Promise<UserAuthorizationSourcesDto> {
    return httpClient.get<UserAuthorizationSourcesDto>(apiRoutes.users.authorization(validId(userId)));
  },

  replaceUserGroups(userId: number, request: ReplaceUserAccessGroupsRequest, idempotencyKey: string): Promise<UserAuthorizationSourcesDto> {
    return httpClient.put<UserAuthorizationSourcesDto>(apiRoutes.users.accessGroups(validId(userId)), request, keyHeaders(idempotencyKey));
  },
};

export function newAccessGroupsActionKey(): string {
  return `access-groups-${crypto.randomUUID()}`;
}

function keyHeaders(idempotencyKey: string) {
  return { headers: { 'Idempotency-Key': idempotencyKey } };
}

function validId(id: number): number {
  if (!Number.isInteger(id) || id < 1) throw new Error('Invalid id');
  return id;
}
