import type { PermissionName } from './authApi.types';

/** Scope values of a group: a set per key (own and assigned together are allowed), never 'none'. */
export type AccessGroupScopes = Record<string, string[]>;

export interface AccessGroupSummaryDto {
  groupId: number;
  code: string;
  name: string;
  description: string | null;
  isActive: boolean;
  version: number;
  memberCount: number;
  permissionCount: number;
}

export interface AccessGroupMemberDto {
  userId: number;
  username: string;
  roleCode: string | null;
  isActive: boolean;
}

export interface AccessGroupDto extends AccessGroupSummaryDto {
  permissions: PermissionName[];
  scopes: AccessGroupScopes;
  members: AccessGroupMemberDto[];
}

export interface AccessGroupsListDto {
  /** While off, groups grant nothing. */
  enabled: boolean;
  /** permissions_state.version — compared by the settings command. */
  permissionsVersion: number;
  groups: AccessGroupSummaryDto[];
}

/** Effective authorization of a user with the source of every grant: 'role' and/or 'group:<code>'. */
export interface UserAuthorizationSourcesDto {
  userId: number;
  username: string;
  roleCode: string | null;
  isActive: boolean;
  rowVersion: number;
  accessGroupsEnabled: boolean;
  groups: Array<{ groupId: number; code: string; name: string; isActive: boolean }>;
  permissions: Array<{ permission: PermissionName; sources: string[] }>;
  scopes: Array<{ scopeKey: string; scopeValue: string; sources: string[] }>;
}

export interface CreateAccessGroupRequest { code: string; name: string; description?: string | null }
export interface UpdateAccessGroupRequest { version: number; name?: string; description?: string | null; isActive?: boolean }
export interface ReplaceAccessGroupPermissionsRequest {
  version: number;
  permissions: string[];
  scopes: AccessGroupScopes;
  confirmDangerous?: boolean;
}
export interface ReplaceAccessGroupMembersRequest { version: number; userIds: number[] }
export interface UpdateAccessGroupsSettingsRequest { enabled: boolean; version: number }
export interface ReplaceUserAccessGroupsRequest { rowVersion: number; groupIds: number[] }
