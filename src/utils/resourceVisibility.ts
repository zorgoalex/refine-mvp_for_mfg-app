import type { IResourceItem } from '@refinedev/core';

export type RoleVisibilityMatrix = Record<string, Record<string, boolean>>;

/**
 * Per-user overrides live in the same setting under a reserved entry, so roles that may
 * read only this setting (operator, worker, packer, viewer) also get their own overrides.
 * Shape: { [USER_VISIBILITY_KEY]: { [resourceName]: { [userId]: boolean } } }.
 * Older clients read the entry as an unknown resource and ignore it.
 */
export const USER_VISIBILITY_KEY = '__users';

export type UserVisibilityOverride = 'inherit' | 'show' | 'hide';

export interface VisibilityUser {
  id?: string | number;
  user_id?: string | number;
  role?: string;
  role_id?: number;
  roleId?: number;
}

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
  const defaultVisible = resourceName !== 'cad' || roleKey === 'admin' || roleKey === 'superadmin';
  if (!matrix || !roleKey) return defaultVisible;
  const resourceVisibility = matrix[resourceName];
  if (!resourceVisibility) return defaultVisible;
  const visible = resourceVisibility[roleKey];
  return visible === undefined ? defaultVisible : visible;
}

export function normalizeRoleVisibilityMatrix(value: unknown): RoleVisibilityMatrix {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

  const matrix = Object.entries(value as Record<string, unknown>).reduce<RoleVisibilityMatrix>((acc, [resourceName, roles]) => {
    if (resourceName === USER_VISIBILITY_KEY) return acc;
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
  const users = normalizeUserVisibilityOverrides((value as Record<string, unknown>)[USER_VISIBILITY_KEY]);
  if (Object.keys(users).length > 0) {
    (matrix as Record<string, unknown>)[USER_VISIBILITY_KEY] = users;
  }
  return matrix;
}

type UserVisibilityOverrides = Record<string, Record<string, boolean>>;

function normalizeUserVisibilityOverrides(value: unknown): UserVisibilityOverrides {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.entries(value as Record<string, unknown>).reduce<UserVisibilityOverrides>((acc, [resourceName, users]) => {
    if (!users || typeof users !== 'object' || Array.isArray(users)) return acc;
    const entries = Object.entries(users as Record<string, unknown>)
      .filter(([userId, visible]) => /^\d+$/.test(userId) && typeof visible === 'boolean') as Array<[string, boolean]>;
    if (entries.length > 0) acc[resourceName] = Object.fromEntries(entries);
    return acc;
  }, {});
}

function userOverrides(matrix: RoleVisibilityMatrix | null | undefined): UserVisibilityOverrides {
  const raw = (matrix as Record<string, unknown> | null | undefined)?.[USER_VISIBILITY_KEY];
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as UserVisibilityOverrides : {};
}

function visibilityUserId(user: VisibilityUser | null | undefined): string | undefined {
  const id = user?.id ?? user?.user_id;
  return id === undefined || id === null || String(id) === '' ? undefined : String(id);
}

export function getUserVisibilityOverride(
  matrix: RoleVisibilityMatrix | null | undefined,
  resourceName: string,
  userId: string | number,
): UserVisibilityOverride {
  const value = userOverrides(matrix)[resourceName]?.[String(userId)];
  return value === undefined ? 'inherit' : value ? 'show' : 'hide';
}

/** Returns a new matrix; 'inherit' removes the override (and empty containers). */
export function setUserVisibilityOverride(
  matrix: RoleVisibilityMatrix,
  resourceName: string,
  userId: string | number,
  override: UserVisibilityOverride,
): RoleVisibilityMatrix {
  const users = { ...userOverrides(matrix) };
  const resourceUsers = { ...(users[resourceName] ?? {}) };
  if (override === 'inherit') delete resourceUsers[String(userId)];
  else resourceUsers[String(userId)] = override === 'show';
  if (Object.keys(resourceUsers).length > 0) users[resourceName] = resourceUsers;
  else delete users[resourceName];

  const next: RoleVisibilityMatrix = { ...matrix };
  delete (next as Record<string, unknown>)[USER_VISIBILITY_KEY];
  if (Object.keys(users).length > 0) (next as Record<string, unknown>)[USER_VISIBILITY_KEY] = users;
  return next;
}

/** Removes every personal override of the user, including screens that are not registered now. */
export function clearUserVisibilityOverrides(
  matrix: RoleVisibilityMatrix,
  userId: string | number,
): RoleVisibilityMatrix {
  return Object.keys(userOverrides(matrix)).reduce(
    (acc, resourceName) => setUserVisibilityOverride(acc, resourceName, userId, 'inherit'),
    matrix,
  );
}

/** Number of screens with a personal override for the user. */
export function countUserVisibilityOverrides(
  matrix: RoleVisibilityMatrix | null | undefined,
  userId: string | number,
): number {
  return Object.values(userOverrides(matrix)).filter((users) => users[String(userId)] !== undefined).length;
}

/** Personal override first, then the role rule, then the default. */
export function canViewResourceForUser(
  resourceName: string,
  user: VisibilityUser | null | undefined,
  matrix: RoleVisibilityMatrix | null | undefined,
): boolean {
  const userId = visibilityUserId(user);
  if (userId !== undefined) {
    const override = userOverrides(matrix)[resourceName]?.[userId];
    if (override !== undefined) return override;
  }
  return canViewResourceByRoleVisibility(resourceName, getCurrentUserRoleKey(user), matrix);
}

export function getMenuResources(
  resources: IResourceItem[],
  labels: Record<string, string>,
  virtualResources: VisibilityResource[] = [],
): VisibilityResource[] {
  const registeredResources = resources
    .map((resource) => {
      const route = typeof resource.list === 'string' ? resource.list : resource.meta?.route ?? '';
      if (!route) return null;
      return {
        name: resource.name,
        label: labels[resource.name] || resource.meta?.label || resource.name,
        route,
      };
    })
    .filter((resource): resource is VisibilityResource => Boolean(resource));
  const registeredNames = new Set(registeredResources.map((resource) => resource.name));

  return [
    ...registeredResources,
    ...virtualResources.filter((resource) => !registeredNames.has(resource.name)),
  ].sort((a, b) => a.label.localeCompare(b.label, 'ru'));
}

export function buildInitialResourceVisibility(
  resources: Array<Pick<VisibilityResource, 'name'>>,
  roles: VisibilityRole[],
  existing: RoleVisibilityMatrix | null | undefined,
): RoleVisibilityMatrix {
  const roleKeys = roles.map(normalizeRoleKey);

  const built = resources.reduce<RoleVisibilityMatrix>((acc, resource) => {
    if (resource.name === USER_VISIBILITY_KEY) return acc;
    acc[resource.name] = roleKeys.reduce<Record<string, boolean>>((roleAcc, roleKey) => {
      roleAcc[roleKey] = canViewResourceByRoleVisibility(resource.name, roleKey, existing);
      return roleAcc;
    }, {});
    return acc;
  }, {});
  // Saving role checkboxes rewrites the whole setting: keep the personal overrides.
  const users = userOverrides(existing);
  if (Object.keys(users).length > 0) (built as Record<string, unknown>)[USER_VISIBILITY_KEY] = users;
  return built;
}
