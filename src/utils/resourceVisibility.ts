import type { IResourceItem } from '@refinedev/core';

export type RoleVisibilityMatrix = Record<string, Record<string, boolean>>;

export interface VisibilityRole {
  role_id: number | string;
  role_name?: string | null;
}

export interface VisibilityResource {
  name: string;
  label: string;
  route: string;
}

const ROLE_ID_TO_KEY: Record<number, string> = {
  1: 'admin',
  2: 'superadmin',
  10: 'manager',
  11: 'operator',
  15: 'top_manager',
  20: 'worker',
  30: 'packer',
  100: 'viewer',
};

export function normalizeRoleKey(role: VisibilityRole): string {
  const roleId = Number(role.role_id);
  return ROLE_ID_TO_KEY[roleId] ?? String(role.role_id);
}

export function getCurrentUserRoleKey(user: { role?: string; role_id?: number; roleId?: number } | null | undefined): string | undefined {
  if (!user) return undefined;
  if (user.role) return user.role;
  const roleId = user.role_id ?? user.roleId;
  return roleId === undefined ? undefined : ROLE_ID_TO_KEY[Number(roleId)] ?? String(roleId);
}

export function canViewResourceByRoleVisibility(
  resourceName: string,
  roleKey: string | undefined,
  matrix: RoleVisibilityMatrix | null | undefined,
): boolean {
  if (!matrix || !roleKey) return true;
  const resourceVisibility = matrix[resourceName];
  if (!resourceVisibility) return true;
  const visible = resourceVisibility[roleKey];
  return visible === undefined ? true : visible;
}

export function normalizeRoleVisibilityMatrix(value: unknown): RoleVisibilityMatrix {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

  return Object.entries(value as Record<string, unknown>).reduce<RoleVisibilityMatrix>((acc, [resourceName, roles]) => {
    if (!roles || typeof roles !== 'object' || Array.isArray(roles)) return acc;
    acc[resourceName] = Object.entries(roles as Record<string, unknown>).reduce<Record<string, boolean>>(
      (roleAcc, [roleKey, visible]) => {
        roleAcc[roleKey] = visible !== false;
        return roleAcc;
      },
      {},
    );
    return acc;
  }, {});
}

export function getMenuResources(
  resources: IResourceItem[],
  labels: Record<string, string>,
): VisibilityResource[] {
  return resources
    .map((resource) => {
      const route = typeof resource.list === 'string' ? resource.list : resource.meta?.route ?? '';
      if (!route) return null;
      return {
        name: resource.name,
        label: labels[resource.name] || resource.meta?.label || resource.name,
        route,
      };
    })
    .filter((resource): resource is VisibilityResource => Boolean(resource))
    .sort((a, b) => a.label.localeCompare(b.label, 'ru'));
}

export function buildInitialResourceVisibility(
  resources: Array<Pick<VisibilityResource, 'name'>>,
  roles: VisibilityRole[],
  existing: RoleVisibilityMatrix | null | undefined,
): RoleVisibilityMatrix {
  const roleKeys = roles.map(normalizeRoleKey);

  return resources.reduce<RoleVisibilityMatrix>((acc, resource) => {
    acc[resource.name] = roleKeys.reduce<Record<string, boolean>>((roleAcc, roleKey) => {
      roleAcc[roleKey] = existing?.[resource.name]?.[roleKey] ?? true;
      return roleAcc;
    }, {});
    return acc;
  }, {});
}
