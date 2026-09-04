import { Injectable, Optional } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { computeDiff } from '../common/audit/audit-diff';
import { ApiError } from '../common/errors/api-error';
import { DatabaseService } from '../database/database.service';
import type { DatabaseClient, TransactionClient } from '../database/database.types';
import type { CurrentUser } from './current-user';
import {
  PERMISSIONS,
  ROLE_PERMISSIONS,
  can,
  getPermissionsForRole,
  isUserRole,
  mapRoleIdToRole,
  mapRoleToRoleId,
  type PermissionName,
  type UserRole,
} from './permissions';
import { ROLE_POLICIES, type RolePolicy, type Scope } from './policies/role-policies';

export const ROLE_POLICY_SCOPE_KEYS = [
  'orders.view',
  'orders.update',
  'orders.export',
  'orders.delete',
  'payments.view',
  'payments.create',
  'payments.update',
  'payments.delete',
  'productionTasks.view',
  'productionTasks.update',
] as const;

export type RolePolicyScopeKey = (typeof ROLE_POLICY_SCOPE_KEYS)[number];

export const ALLOWED_SCOPE_VALUES = {
  'orders.view': ['all', 'own', 'assigned', 'none'],
  'orders.update': ['all', 'own', 'assigned', 'none'],
  'orders.export': ['all', 'own', 'assigned', 'none'],
  'orders.delete': ['all', 'own', 'assigned', 'none'],
  'payments.view': ['all', 'own', 'none'],
  'payments.create': ['all', 'own', 'none'],
  'payments.update': ['all', 'own', 'none'],
  'payments.delete': ['all', 'own', 'none'],
  'productionTasks.view': ['all', 'assigned', 'none'],
  'productionTasks.update': ['all', 'assigned', 'none'],
} as const satisfies Record<RolePolicyScopeKey, readonly Scope[]>;

const DANGEROUS_PERMISSIONS = new Set<PermissionName>([
  'system.superadmin',
  'roles.manage',
  'permissions.manage',
  'sessions.revoke_any',
  'users.change_password',
  'users.deactivate',
  'users.activate',
  'users.manage_sso',
  'orders.delete',
  'payments.delete',
  'bitrix24.payments.create',
  'bitrix24.payments.confirm_overpayment',
  'settings.manage',
  'audit.technical.view',
]);

const REQUIRED_SUPERADMIN_PERMISSIONS: PermissionName[] = [
  'system.superadmin',
  'roles.manage',
  'permissions.manage',
];

interface RoleRow extends QueryResultRow {
  role_id: string | number;
  role_code: string | null;
  role_name: string;
  is_active: boolean;
}

interface PermissionRow extends QueryResultRow {
  permission_name: PermissionName;
}

interface ScopeRow extends QueryResultRow {
  scope_key: RolePolicyScopeKey;
  scope_value: Scope;
}

interface VersionRow extends QueryResultRow {
  version: string | number;
}

interface CountRow extends QueryResultRow {
  total: string | number;
}

export interface RoleAuthorizationSnapshot {
  permissions: readonly PermissionName[];
  scopes: RolePolicy;
  version: number;
}

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
  key: RolePolicyScopeKey;
  label: string;
  allowedValues: readonly Scope[];
}

export interface RolesMatrixDto {
  version: number;
  roles: RoleMatrixRoleDto[];
  permissions: PermissionCatalogDto[];
  rolePermissions: Record<string, Record<string, boolean>>;
  scopeKeys: ScopeKeyDto[];
  roleScopes: Record<string, Record<string, Scope>>;
  defaults: {
    rolePermissions: Record<string, Record<string, boolean>>;
    roleScopes: Record<string, Record<string, Scope>>;
  };
}

export interface UpdateRolesMatrixRequest {
  version: number;
  rolePermissions: Record<string, Record<string, boolean>>;
  roleScopes: Record<string, Partial<Record<RolePolicyScopeKey, Scope>>>;
  confirmDangerous?: boolean;
}

@Injectable()
export class PermissionsService {
  constructor(@Optional() private readonly database?: DatabaseService) {}

  mapRoleIdToRole(roleId: number): UserRole | null {
    return mapRoleIdToRole(roleId);
  }

  getPermissionsForRole(role: UserRole): readonly PermissionName[] {
    return getPermissionsForRole(role);
  }

  canRole(role: UserRole, permission: PermissionName): boolean {
    return can(role, permission);
  }

  canUser(user: CurrentUser | null | undefined, permission: PermissionName): boolean {
    return Boolean(user?.permissions.includes(permission));
  }

  canUserAny(user: CurrentUser | null | undefined, permissions: readonly PermissionName[]): boolean {
    return permissions.some((permission) => this.canUser(user, permission));
  }

  async loadRoleAuthorization(roleId: number): Promise<RoleAuthorizationSnapshot> {
    const staticRole = mapRoleIdToRole(roleId);

    if (!this.database?.isConfigured) {
      if (!staticRole) {
        throw new ApiError(500, 'UNKNOWN_ROLE', 'User role is not supported by backend', { roleId });
      }
      return {
        permissions: getPermissionsForRole(staticRole),
        scopes: cloneRolePolicy(ROLE_POLICIES[staticRole]),
        version: 0,
      };
    }

    try {
      await this.seedDefaults();

      const roleResult = await this.database.query<RoleRow>(
        'SELECT role_id, role_code, role_name, is_active FROM roles WHERE role_id = $1',
        [roleId],
      );

      if (!roleResult.rows[0]) {
        throw new ApiError(500, 'UNKNOWN_ROLE', 'User role is not supported by backend', { roleId });
      }

      const [permissionResult, scopeResult, version] = await Promise.all([
        this.database.query<PermissionRow>(
          `
          SELECT rp.permission_name
          FROM role_permissions rp
          JOIN permissions_catalog pc ON pc.permission_name = rp.permission_name
          WHERE rp.role_id = $1 AND rp.is_enabled = true AND pc.is_active = true
          ORDER BY pc.sort_order, rp.permission_name
          `,
          [roleId],
        ),
        this.database.query<ScopeRow>(
          `
          SELECT scope_key, scope_value
          FROM role_policy_scopes
          WHERE role_id = $1
          `,
          [roleId],
        ),
        this.getAuthorizationVersion(),
      ]);

      return {
        permissions: permissionResult.rows.map((row) => row.permission_name),
        scopes: scopesFromRows(scopeResult.rows),
        version,
      };
    } catch (error) {
      throw mapPermissionsRuntimeError(error);
    }
  }

  async getAuthorizationVersion(client?: DatabaseClient): Promise<number> {
    if (!this.database?.isConfigured) {
      return 0;
    }

    const target = client ?? this.database;
    const result = await target.query<VersionRow>(
      `SELECT version FROM permissions_state WHERE id = true`,
    );
    const version = Number(result.rows[0]?.version);
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new ApiError(503, 'PERMISSIONS_NOT_READY', 'Permissions runtime state is not initialized');
    }
    return version;
  }

  async getRolesMatrix(): Promise<RolesMatrixDto> {
    const database = this.requireDatabase();
    await this.seedDefaults();
    return this.readMatrix(database);
  }

  async updateRolesMatrix(
    currentUser: CurrentUser,
    request: UpdateRolesMatrixRequest,
    requestId = 'permissions-matrix',
  ): Promise<RolesMatrixDto> {
    this.requireMatrixMutationAccess(currentUser);
    return this.requireDatabase().transaction(async (tx) => {
      await this.seedDefaults(tx);
      const before = await this.readMatrix(tx, { lockState: true });
      this.assertExpectedVersion(request.version, before.version);
      const next = normalizeRequestedMatrix(request, before);
      assertDangerousConfirmed(before, next, request.confirmDangerous === true);
      await assertLockoutSafe(tx, next);

      await writeMatrixRows(tx, next);
      const afterVersion = await bumpPermissionsVersion(tx);
      const after = await this.readMatrix(tx, { version: afterVersion });
      await writePermissionsAudit(tx, {
        currentUser,
        requestId,
        event: 'permissions.roles_matrix.update',
        before,
        after,
      });
      return after;
    });
  }

  async resetRoleToDefaults(
    currentUser: CurrentUser,
    roleId: number,
    requestId = 'permissions-matrix-reset',
  ): Promise<RolesMatrixDto> {
    this.requireMatrixMutationAccess(currentUser);
    return this.requireDatabase().transaction(async (tx) => {
      await this.seedDefaults(tx);
      const before = await this.readMatrix(tx, { lockState: true });
      const role = before.roles.find((row) => row.roleId === roleId);
      if (!role) {
        throw new ApiError(404, 'ROLE_NOT_FOUND', 'Role was not found', { roleId });
      }
      const next = cloneMatrixState(before);
      next.rolePermissions[String(roleId)] = defaultPermissionsForRoleCode(role.roleCode);
      next.roleScopes[String(roleId)] = defaultScopesForRoleCode(role.roleCode);
      await assertLockoutSafe(tx, next);

      await writeMatrixRows(tx, next, { onlyRoleId: roleId });
      const afterVersion = await bumpPermissionsVersion(tx);
      const after = await this.readMatrix(tx, { version: afterVersion });
      await writePermissionsAudit(tx, {
        currentUser,
        requestId,
        event: 'permissions.roles_matrix.reset',
        before,
        after,
        roleId,
      });
      return after;
    });
  }

  private requireMatrixMutationAccess(currentUser: CurrentUser): void {
    if (
      !this.canUser(currentUser, 'system.superadmin') ||
      !this.canUser(currentUser, 'permissions.manage')
    ) {
      throw new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав для выполнения действия', {
        requiredPermissions: ['system.superadmin', 'permissions.manage'],
      });
    }
  }

  private async readMatrix(
    client: DatabaseClient,
    options: { lockState?: boolean; version?: number } = {},
  ): Promise<RolesMatrixDto> {
    const version = options.version ?? await this.readVersion(client, options.lockState === true);
    const [rolesResult, permissionsResult, rolePermissionsResult, roleScopesResult] = await Promise.all([
      client.query<RoleRow>(
        `
        SELECT role_id, role_code, role_name, is_active
        FROM roles
        ORDER BY role_id
        `,
      ),
      client.query<PermissionCatalogRow>(
        `
        SELECT permission_name, domain, label, description, sort_order, is_dangerous, is_active
        FROM permissions_catalog
        WHERE is_active = true
        ORDER BY sort_order, permission_name
        `,
      ),
      client.query<RolePermissionMatrixRow>(
        `
        SELECT role_id, permission_name, is_enabled
        FROM role_permissions
        ORDER BY role_id, permission_name
        `,
      ),
      client.query<RoleScopeMatrixRow>(
        `
        SELECT role_id, scope_key, scope_value
        FROM role_policy_scopes
        ORDER BY role_id, scope_key
        `,
      ),
    ]);

    const roles = rolesResult.rows.map((row) => ({
      roleId: Number(row.role_id),
      roleCode: row.role_code ?? String(row.role_id),
      roleName: row.role_name,
      isActive: row.is_active,
    }));
    const permissions = permissionsResult.rows.map((row) => ({
      name: row.permission_name,
      domain: row.domain,
      label: row.label,
      description: row.description,
      sortOrder: Number(row.sort_order),
      isDangerous: row.is_dangerous,
      isActive: row.is_active,
    }));
    const permissionNames = permissions.map((permission) => permission.name);
    const rolePermissions = Object.fromEntries(
      roles.map((role) => [
        String(role.roleId),
        Object.fromEntries(permissionNames.map((permission) => [permission, false])),
      ]),
    ) as Record<string, Record<string, boolean>>;
    for (const row of rolePermissionsResult.rows) {
      const roleKey = String(row.role_id);
      if (rolePermissions[roleKey]) {
        rolePermissions[roleKey][row.permission_name] = row.is_enabled;
      }
    }

    const roleScopes = Object.fromEntries(
      roles.map((role) => [
        String(role.roleId),
        Object.fromEntries(ROLE_POLICY_SCOPE_KEYS.map((key) => [key, 'none' as Scope])),
      ]),
    ) as Record<string, Record<string, Scope>>;
    for (const row of roleScopesResult.rows) {
      const roleKey = String(row.role_id);
      if (roleScopes[roleKey] && isRolePolicyScopeKey(row.scope_key) && isScope(row.scope_value)) {
        roleScopes[roleKey][row.scope_key] = row.scope_value;
      }
    }

    return {
      version,
      roles,
      permissions,
      rolePermissions,
      scopeKeys: ROLE_POLICY_SCOPE_KEYS.map((key) => ({
        key,
        label: key,
        allowedValues: ALLOWED_SCOPE_VALUES[key],
      })),
      roleScopes,
      defaults: {
        rolePermissions: Object.fromEntries(
          roles.map((role) => [String(role.roleId), defaultPermissionsForRoleCode(role.roleCode)]),
        ),
        roleScopes: Object.fromEntries(
          roles.map((role) => [String(role.roleId), defaultScopesForRoleCode(role.roleCode)]),
        ),
      },
    };
  }

  private async readVersion(client: DatabaseClient, lockState: boolean): Promise<number> {
    const result = await client.query<VersionRow>(
      `SELECT version FROM permissions_state WHERE id = true${lockState ? ' FOR UPDATE' : ''}`,
    );
    const version = Number(result.rows[0]?.version);
    if (!Number.isSafeInteger(version) || version < 1) {
      throw new ApiError(503, 'PERMISSIONS_NOT_READY', 'Permissions runtime state is not initialized');
    }
    return version;
  }

  private assertExpectedVersion(expected: number, actual: number): void {
    if (!Number.isSafeInteger(expected) || expected < 1) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Invalid permissions matrix version');
    }
    if (expected !== actual) {
      throw new ApiError(409, 'PERMISSIONS_VERSION_CONFLICT', 'Права были изменены. Обновите матрицу.', {
        expectedVersion: expected,
        currentVersion: actual,
      });
    }
  }

  async seedDefaults(client?: DatabaseClient): Promise<void> {
    const target = client ?? this.requireDatabase();
    const catalogRows = PERMISSIONS.map((permission, index) => ({
      permission,
      domain: permissionDomain(permission),
      label: permission,
      description: null as string | null,
      sortOrder: index + 1,
      isDangerous: DANGEROUS_PERMISSIONS.has(permission),
    }));
    const catalogParams: unknown[] = [];
    const catalogValues = catalogRows.map((row) => {
      const base = catalogParams.length;
      catalogParams.push(row.permission, row.domain, row.label, row.description, row.sortOrder, row.isDangerous);
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
    });

    await target.query(
      `
      INSERT INTO permissions_catalog (
        permission_name, domain, label, description, sort_order, is_dangerous
      )
      VALUES ${catalogValues.join(', ')}
      ON CONFLICT (permission_name) DO UPDATE
      SET domain = EXCLUDED.domain,
          label = EXCLUDED.label,
          description = EXCLUDED.description,
          sort_order = EXCLUDED.sort_order,
          is_dangerous = EXCLUDED.is_dangerous,
          is_active = true,
          updated_at = now()
      `,
      catalogParams,
    );

    const rolePermissionParams: unknown[] = [];
    const rolePermissionValues: string[] = [];
    for (const role of Object.keys(ROLE_PERMISSIONS) as UserRole[]) {
      const roleId = mapRoleToRoleId(role);
      const enabled = new Set(ROLE_PERMISSIONS[role]);
      for (const permission of PERMISSIONS) {
        const base = rolePermissionParams.length;
        rolePermissionParams.push(roleId, permission, enabled.has(permission));
        rolePermissionValues.push(`($${base + 1}, $${base + 2}, $${base + 3})`);
      }
    }
    await target.query(
      `
      INSERT INTO role_permissions (role_id, permission_name, is_enabled)
      VALUES ${rolePermissionValues.join(', ')}
      ON CONFLICT (role_id, permission_name) DO NOTHING
      `,
      rolePermissionParams,
    );

    const scopeParams: unknown[] = [];
    const scopeValues: string[] = [];
    for (const role of Object.keys(ROLE_POLICIES) as UserRole[]) {
      const roleId = mapRoleToRoleId(role);
      const flat = flattenRolePolicy(ROLE_POLICIES[role]);
      for (const key of ROLE_POLICY_SCOPE_KEYS) {
        const base = scopeParams.length;
        scopeParams.push(roleId, key, flat[key]);
        scopeValues.push(`($${base + 1}, $${base + 2}, $${base + 3})`);
      }
    }
    await target.query(
      `
      INSERT INTO role_policy_scopes (role_id, scope_key, scope_value)
      VALUES ${scopeValues.join(', ')}
      ON CONFLICT (role_id, scope_key) DO NOTHING
      `,
      scopeParams,
    );

    await target.query(
      `
      INSERT INTO permissions_state (id, version)
      VALUES (true, 1)
      ON CONFLICT (id) DO NOTHING
      `,
    );
  }

  private requireDatabase(): DatabaseService {
    if (!this.database?.isConfigured) {
      throw new ApiError(503, 'DATABASE_UNAVAILABLE', 'Database is not configured');
    }
    return this.database;
  }
}

interface PermissionCatalogRow extends QueryResultRow {
  permission_name: PermissionName;
  domain: string;
  label: string;
  description: string | null;
  sort_order: string | number;
  is_dangerous: boolean;
  is_active: boolean;
}

interface RolePermissionMatrixRow extends QueryResultRow {
  role_id: string | number;
  permission_name: PermissionName;
  is_enabled: boolean;
}

interface RoleScopeMatrixRow extends QueryResultRow {
  role_id: string | number;
  scope_key: string;
  scope_value: string;
}

function permissionDomain(permission: PermissionName): string {
  if (permission.startsWith('status_automation.')) return 'status_automation';
  if (permission.startsWith('sheet_materials.')) return 'sheet_materials';
  return permission.split('.')[0] ?? 'system';
}

function cloneRolePolicy(policy: RolePolicy): RolePolicy {
  return {
    orders: { ...policy.orders },
    payments: { ...policy.payments },
    productionTasks: { ...policy.productionTasks },
  };
}

function flattenRolePolicy(policy: RolePolicy): Record<RolePolicyScopeKey, Scope> {
  return {
    'orders.view': policy.orders.view,
    'orders.update': policy.orders.update,
    'orders.export': policy.orders.export,
    'orders.delete': policy.orders.delete,
    'payments.view': policy.payments.view,
    'payments.create': policy.payments.create,
    'payments.update': policy.payments.update,
    'payments.delete': policy.payments.delete,
    'productionTasks.view': policy.productionTasks.view,
    'productionTasks.update': policy.productionTasks.update,
  };
}

function scopesFromRows(rows: readonly ScopeRow[]): RolePolicy {
  const flat = Object.fromEntries(ROLE_POLICY_SCOPE_KEYS.map((key) => [key, 'none' as Scope])) as Record<RolePolicyScopeKey, Scope>;
  for (const row of rows) {
    if (isRolePolicyScopeKey(row.scope_key) && isScope(row.scope_value)) {
      flat[row.scope_key] = row.scope_value;
    }
  }
  return {
    orders: {
      view: flat['orders.view'],
      update: flat['orders.update'],
      export: flat['orders.export'],
      delete: flat['orders.delete'],
    },
    payments: {
      view: flat['payments.view'],
      create: flat['payments.create'],
      update: flat['payments.update'],
      delete: flat['payments.delete'],
    },
    productionTasks: {
      view: flat['productionTasks.view'],
      update: flat['productionTasks.update'],
    },
  };
}

function defaultPermissionsForRoleCode(roleCode: string): Record<string, boolean> {
  const role = isUserRole(roleCode) ? roleCode : null;
  const enabled = role ? new Set(ROLE_PERMISSIONS[role]) : new Set<PermissionName>();
  return Object.fromEntries(PERMISSIONS.map((permission) => [permission, enabled.has(permission)]));
}

function defaultScopesForRoleCode(roleCode: string): Record<string, Scope> {
  if (!isUserRole(roleCode)) {
    return Object.fromEntries(ROLE_POLICY_SCOPE_KEYS.map((key) => [key, 'none' as Scope]));
  }
  return flattenRolePolicy(ROLE_POLICIES[roleCode]);
}

function cloneMatrixState(matrix: RolesMatrixDto): RolesMatrixDto {
  return {
    ...matrix,
    roles: matrix.roles.map((role) => ({ ...role })),
    permissions: matrix.permissions.map((permission) => ({ ...permission })),
    rolePermissions: cloneNestedBooleanMap(matrix.rolePermissions),
    roleScopes: cloneNestedScopeMap(matrix.roleScopes),
    defaults: {
      rolePermissions: cloneNestedBooleanMap(matrix.defaults.rolePermissions),
      roleScopes: cloneNestedScopeMap(matrix.defaults.roleScopes),
    },
  };
}

function cloneNestedBooleanMap(input: Record<string, Record<string, boolean>>): Record<string, Record<string, boolean>> {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, { ...value }]));
}

function cloneNestedScopeMap(input: Record<string, Record<string, Scope>>): Record<string, Record<string, Scope>> {
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, { ...value }]));
}

function normalizeRequestedMatrix(request: UpdateRolesMatrixRequest, before: RolesMatrixDto): RolesMatrixDto {
  const next = cloneMatrixState(before);
  const validRoleIds = new Set(before.roles.map((role) => String(role.roleId)));
  const validPermissions = new Set(before.permissions.map((permission) => permission.name));

  for (const roleId of Object.keys(request.rolePermissions ?? {})) {
    if (!validRoleIds.has(roleId)) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Unknown role in permissions matrix', { roleId });
    }
    const roleMap = request.rolePermissions[roleId];
    if (!roleMap || typeof roleMap !== 'object') {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Role permissions row is invalid', { roleId });
    }
    for (const [permission, enabled] of Object.entries(roleMap)) {
      if (!validPermissions.has(permission as PermissionName)) {
        throw new ApiError(422, 'VALIDATION_ERROR', 'Unknown permission in permissions matrix', {
          roleId,
          permission,
        });
      }
      if (typeof enabled !== 'boolean') {
        throw new ApiError(422, 'VALIDATION_ERROR', 'Permission value must be boolean', {
          roleId,
          permission,
        });
      }
      next.rolePermissions[roleId][permission] = enabled;
    }
    applyPermissionDependencies(next.rolePermissions[roleId]);
  }

  for (const roleId of Object.keys(request.roleScopes ?? {})) {
    if (!validRoleIds.has(roleId)) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Unknown role in scopes matrix', { roleId });
    }
    const scopes = request.roleScopes[roleId];
    if (!scopes || typeof scopes !== 'object') {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Role scopes row is invalid', { roleId });
    }
    for (const [scopeKey, scopeValue] of Object.entries(scopes)) {
      if (!isRolePolicyScopeKey(scopeKey)) {
        throw new ApiError(422, 'VALIDATION_ERROR', 'Unknown scope key in permissions matrix', {
          roleId,
          scopeKey,
        });
      }
      const allowedValues: readonly Scope[] = ALLOWED_SCOPE_VALUES[scopeKey];
      if (!isScope(scopeValue) || !allowedValues.includes(scopeValue)) {
        throw new ApiError(422, 'VALIDATION_ERROR', 'Scope value is not allowed for this key', {
          roleId,
          scopeKey,
          scopeValue,
          allowedValues,
        });
      }
      next.roleScopes[roleId][scopeKey] = scopeValue;
    }
  }

  return next;
}

function applyPermissionDependencies(row: Record<string, boolean>): void {
  for (const permission of Object.keys(row)) {
    if (!row[permission]) continue;
    if (permission.endsWith('.create') || permission.endsWith('.update') || permission.endsWith('.delete')) {
      const viewPermission = `${permission.split('.')[0]}.view`;
      if (viewPermission in row) {
        row[viewPermission] = true;
      }
    }
    if (permission.startsWith('payments.')) {
      row['orders.view'] = true;
    }
  }
}

function assertDangerousConfirmed(before: RolesMatrixDto, next: RolesMatrixDto, confirmed: boolean): void {
  if (confirmed) return;
  const changed: Array<{ roleId: string; permission: string; before: boolean; after: boolean }> = [];
  for (const role of next.roles) {
    const roleId = String(role.roleId);
    for (const permission of next.permissions) {
      if (!permission.isDangerous) continue;
      const was = before.rolePermissions[roleId]?.[permission.name] === true;
      const now = next.rolePermissions[roleId]?.[permission.name] === true;
      if (was !== now) {
        changed.push({ roleId, permission: permission.name, before: was, after: now });
      }
    }
  }
  if (changed.length > 0) {
    throw new ApiError(
      422,
      'DANGEROUS_PERMISSION_CONFIRMATION_REQUIRED',
      'Подтвердите изменение опасных прав',
      { changed },
    );
  }
}

async function assertLockoutSafe(tx: TransactionClient, next: RolesMatrixDto): Promise<void> {
  const activeUsers = await tx.query<{ role_id: string | number } & QueryResultRow>(
    `SELECT DISTINCT role_id FROM users WHERE is_active = true`,
  );
  const activeRoleIds = activeUsers.rows.map((row) => String(row.role_id));
  const hasManagerPath = activeRoleIds.some((roleId) =>
    REQUIRED_SUPERADMIN_PERMISSIONS.every((permission) => next.rolePermissions[roleId]?.[permission] === true),
  );
  if (!hasManagerPath) {
    throw new ApiError(
      409,
      'PERMISSIONS_LOCKOUT_DENIED',
      'Нельзя убрать последний активный путь управления правами',
      { requiredPermissions: REQUIRED_SUPERADMIN_PERMISSIONS },
    );
  }

  const superadminRole = next.roles.find((role) => role.roleCode === 'superadmin');
  if (superadminRole) {
    const activeSuperadmins = await tx.query<CountRow>(
      `SELECT count(*)::int AS total FROM users WHERE is_active = true AND role_id = $1`,
      [superadminRole.roleId],
    );
    const total = Number(activeSuperadmins.rows[0]?.total ?? 0);
    if (
      total > 0 &&
      !REQUIRED_SUPERADMIN_PERMISSIONS.every(
        (permission) => next.rolePermissions[String(superadminRole.roleId)]?.[permission] === true,
      )
    ) {
      throw new ApiError(
        409,
        'SUPERADMIN_CONTROL_DENIED',
        'Нельзя убрать базовые права у активной роли superadmin',
        { roleId: superadminRole.roleId, requiredPermissions: REQUIRED_SUPERADMIN_PERMISSIONS },
      );
    }
  }
}

async function writeMatrixRows(
  tx: TransactionClient,
  matrix: RolesMatrixDto,
  options: { onlyRoleId?: number } = {},
): Promise<void> {
  const roles = options.onlyRoleId
    ? matrix.roles.filter((role) => role.roleId === options.onlyRoleId)
    : matrix.roles;
  for (const role of roles) {
    const roleId = String(role.roleId);
    const permissionEntries = Object.entries(matrix.rolePermissions[roleId] ?? {});
    for (const [permission, enabled] of permissionEntries) {
      await tx.query(
        `
        INSERT INTO role_permissions (role_id, permission_name, is_enabled, updated_at)
        VALUES ($1, $2, $3, now())
        ON CONFLICT (role_id, permission_name) DO UPDATE
        SET is_enabled = EXCLUDED.is_enabled,
            updated_at = now()
        `,
        [role.roleId, permission, enabled],
      );
    }
    for (const [scopeKey, scopeValue] of Object.entries(matrix.roleScopes[roleId] ?? {})) {
      if (!isRolePolicyScopeKey(scopeKey) || !isScope(scopeValue)) continue;
      await tx.query(
        `
        INSERT INTO role_policy_scopes (role_id, scope_key, scope_value, updated_at)
        VALUES ($1, $2, $3, now())
        ON CONFLICT (role_id, scope_key) DO UPDATE
        SET scope_value = EXCLUDED.scope_value,
            updated_at = now()
        `,
        [role.roleId, scopeKey, scopeValue],
      );
    }
  }
}

async function bumpPermissionsVersion(tx: TransactionClient): Promise<number> {
  const result = await tx.query<VersionRow>(
    `
    UPDATE permissions_state
    SET version = version + 1,
        updated_at = now()
    WHERE id = true
    RETURNING version
    `,
  );
  return Number(result.rows[0]?.version);
}

async function writePermissionsAudit(
  tx: TransactionClient,
  input: {
    currentUser: CurrentUser;
    requestId: string;
    event: 'permissions.roles_matrix.update' | 'permissions.roles_matrix.reset';
    before: RolesMatrixDto;
    after: RolesMatrixDto;
    roleId?: number;
  },
): Promise<void> {
  await tx.query(
    `
    INSERT INTO audit_log (
      event, entity_type, entity_id, user_id, username, role_code, role,
      request_id, source, before_json, after_json, diff_json, metadata_json
    )
    VALUES ($1, 'role_permissions_matrix', $2, $3, $4, $5, $5, $6, 'backend', $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb)
    `,
    [
      input.event,
      input.roleId ? String(input.roleId) : 'all',
      toNullableUserId(input.currentUser.id),
      input.currentUser.username,
      input.currentUser.role,
      input.requestId,
      JSON.stringify(sanitizeMatrixForAudit(input.before)),
      JSON.stringify(sanitizeMatrixForAudit(input.after)),
      JSON.stringify(computeDiff(sanitizeMatrixForAudit(input.before), sanitizeMatrixForAudit(input.after))),
      JSON.stringify({
        permissionsVersionBefore: input.before.version,
        permissionsVersionAfter: input.after.version,
        roleId: input.roleId ?? null,
      }),
    ],
  );
}

function sanitizeMatrixForAudit(matrix: RolesMatrixDto): Record<string, unknown> {
  return {
    version: matrix.version,
    rolePermissions: matrix.rolePermissions,
    roleScopes: matrix.roleScopes,
  };
}

function toNullableUserId(value: string): number | null {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function isRolePolicyScopeKey(value: string): value is RolePolicyScopeKey {
  return ROLE_POLICY_SCOPE_KEYS.includes(value as RolePolicyScopeKey);
}

function isScope(value: unknown): value is Scope {
  return value === 'all' || value === 'own' || value === 'assigned' || value === 'none';
}

function mapPermissionsRuntimeError(error: unknown): never {
  if (error instanceof ApiError) {
    throw error;
  }
  const code = typeof error === 'object' && error && 'code' in error ? String((error as { code?: unknown }).code) : '';
  if (code === '42P01' || code === '42703') {
    throw new ApiError(503, 'PERMISSIONS_SCHEMA_MISSING', 'Permissions runtime schema is not ready');
  }
  throw error;
}
