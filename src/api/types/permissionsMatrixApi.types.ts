import type { PermissionName } from './authApi.types';

export type RolePolicyScopeValue = 'all' | 'own' | 'assigned' | 'none';

export interface RoleMatrixRoleDto {
  roleId: number;
  roleCode: string;
  roleName: string;
  isActive: boolean;
}

export interface PermissionCatalogDto {
  name: PermissionName;
  domain: string;
  label: string;
  description: string | null;
  sortOrder: number;
  isDangerous: boolean;
  isActive: boolean;
}

export interface ScopeKeyDto {
  key: string;
  label: string;
  allowedValues: RolePolicyScopeValue[];
}

export interface RolesMatrixDto {
  version: number;
  roles: RoleMatrixRoleDto[];
  permissions: PermissionCatalogDto[];
  rolePermissions: Record<string, Record<string, boolean>>;
  scopeKeys: ScopeKeyDto[];
  roleScopes: Record<string, Record<string, RolePolicyScopeValue>>;
  defaults: {
    rolePermissions: Record<string, Record<string, boolean>>;
    roleScopes: Record<string, Record<string, RolePolicyScopeValue>>;
  };
}

export interface UpdateRolesMatrixRequest {
  version: number;
  rolePermissions: Record<string, Record<string, boolean>>;
  roleScopes: Record<string, Record<string, RolePolicyScopeValue>>;
  confirmDangerous?: boolean;
}
