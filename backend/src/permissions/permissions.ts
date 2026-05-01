export const USER_ROLES = [
  'superadmin',
  'admin',
  'top_manager',
  'manager',
  'operator',
  'worker',
  'viewer',
] as const;

export type UserRole = (typeof USER_ROLES)[number];

export const ROLE_ID_TO_ROLE = {
  1: 'admin',
  2: 'superadmin',
  10: 'manager',
  11: 'operator',
  15: 'top_manager',
  20: 'worker',
  100: 'viewer',
} as const satisfies Record<number, UserRole>;

export type KnownRoleId = keyof typeof ROLE_ID_TO_ROLE;

export const PERMISSIONS = [
  'profile.view',
  'profile.update_own',
  'sessions.logout_own',
  'sessions.revoke_any',

  'orders.view',
  'orders.create',
  'orders.update',
  'orders.delete',
  'orders.change_status',
  'orders.change_production_status',
  'orders.export',
  'orders.view_financials',
  'orders.view_audit',

  'payments.view',
  'payments.create',
  'payments.update',
  'payments.delete',
  'finance.view',
  'finance.analytics.view',

  'clients.view',
  'clients.create',
  'clients.update',
  'clients.delete',
  'clients.analytics.view',

  'suppliers.view',
  'suppliers.manage',
  'vendors.view',
  'vendors.manage',

  'materials.view',
  'materials.manage',
  'references.view',
  'references.manage',

  'calendar.view',
  'production.view',
  'production.manage',
  'production.tasks.view',
  'production.tasks.update',
  'workshops.view',
  'workshops.manage',
  'work_centers.view',
  'work_centers.manage',

  'requirements.view',
  'requirements.create',
  'requirements.update',
  'requirements.delete',
  'procurement.view',
  'procurement.manage',

  'doweling.view',
  'doweling.create',
  'doweling.update',
  'doweling.delete',

  'users.view',
  'users.create',
  'users.update',
  'users.change_password',
  'users.deactivate',
  'users.activate',
  'employees.view',
  'employees.manage',

  'roles.manage',
  'permissions.manage',

  'vlm.use',
  'vlm.configure',
  'vlm.health.view',

  'settings.view',
  'settings.manage',
  'audit.view',
  'system.health.view',
  'system.superadmin',
] as const;

export type PermissionName = (typeof PERMISSIONS)[number];

const ALL_PERMISSIONS = [...PERMISSIONS];

const ADMIN_SERVICE_EXCLUDED_PERMISSIONS = [
  'roles.manage',
  'permissions.manage',
  'system.superadmin',
] as const satisfies PermissionName[];

const adminServiceExcludedPermissions = new Set<PermissionName>(ADMIN_SERVICE_EXCLUDED_PERMISSIONS);

const adminServicePermissions = ALL_PERMISSIONS.filter(
  (permission) => !adminServiceExcludedPermissions.has(permission),
);

export const ROLE_PERMISSIONS = {
  superadmin: ALL_PERMISSIONS,

  // Service application administrator: manages users, settings, references,
  // support operations, and integrations, but does not own superadmin-only
  // role/permission model changes or policy bypass.
  admin: adminServicePermissions,

  top_manager: [
    'profile.view',
    'profile.update_own',
    'sessions.logout_own',

    'orders.view',
    'orders.create',
    'orders.update',
    'orders.change_status',
    'orders.change_production_status',
    'orders.export',
    'orders.view_financials',
    'orders.view_audit',

    'payments.view',
    'payments.create',
    'payments.update',
    'finance.view',
    'finance.analytics.view',

    'clients.view',
    'clients.create',
    'clients.update',
    'clients.analytics.view',

    'suppliers.view',
    'suppliers.manage',
    'vendors.view',
    'vendors.manage',

    'materials.view',
    'materials.manage',
    'references.view',
    'references.manage',

    'calendar.view',
    'production.view',
    'production.manage',
    'production.tasks.view',
    'production.tasks.update',
    'workshops.view',
    'workshops.manage',
    'work_centers.view',
    'work_centers.manage',

    'requirements.view',
    'requirements.create',
    'requirements.update',
    'requirements.delete',
    'procurement.view',
    'procurement.manage',

    'doweling.view',
    'doweling.create',
    'doweling.update',

    'employees.view',
    'employees.manage',

    'vlm.use',
  ],

  manager: [
    'profile.view',
    'profile.update_own',
    'sessions.logout_own',

    'orders.view',
    'orders.create',
    'orders.update',
    'orders.change_status',
    'orders.change_production_status',
    'orders.export',
    'orders.view_financials',

    'payments.view',
    'payments.create',
    'payments.update',
    'finance.view',

    'clients.view',
    'clients.create',
    'clients.update',
    'clients.analytics.view',

    'suppliers.view',
    'vendors.view',

    'materials.view',
    'references.view',

    'calendar.view',
    'production.view',
    'production.tasks.view',
    'production.tasks.update',
    'workshops.view',
    'work_centers.view',

    'requirements.view',
    'requirements.create',
    'requirements.update',
    'procurement.view',

    'doweling.view',
    'doweling.create',
    'doweling.update',

    'employees.view',

    'vlm.use',
  ],

  operator: [
    'profile.view',
    'profile.update_own',
    'sessions.logout_own',

    'orders.view',
    'orders.create',
    'orders.update',
    'orders.change_status',
    'orders.change_production_status',
    'orders.export',

    'clients.view',
    'clients.create',
    'clients.update',

    'suppliers.view',
    'vendors.view',

    'materials.view',
    'references.view',

    'calendar.view',
    'production.view',
    'production.tasks.view',
    'production.tasks.update',
    'workshops.view',
    'work_centers.view',

    'requirements.view',
    'requirements.create',
    'requirements.update',

    'doweling.view',
    'doweling.create',
    'doweling.update',

    'employees.view',

    'vlm.use',
  ],

  worker: [
    'profile.view',
    'profile.update_own',
    'sessions.logout_own',

    'orders.view',
    'orders.change_production_status',

    'materials.view',
    'references.view',

    'calendar.view',
    'production.view',
    'production.tasks.view',
    'production.tasks.update',
    'workshops.view',
    'work_centers.view',

    'requirements.view',
    'doweling.view',

    'employees.view',
  ],

  viewer: [
    'profile.view',
    'profile.update_own',
    'sessions.logout_own',

    'orders.view',

    'clients.view',
    'suppliers.view',
    'vendors.view',

    'materials.view',
    'references.view',

    'calendar.view',
    'production.view',
    'production.tasks.view',
    'workshops.view',
    'work_centers.view',

    'requirements.view',
    'doweling.view',

    'employees.view',
  ],
} as const satisfies Record<UserRole, readonly PermissionName[]>;

export const HASURA_ALLOWED_ROLES = {
  superadmin: ['superadmin', 'admin', 'top_manager', 'manager', 'operator', 'worker', 'viewer'],
  admin: ['admin', 'top_manager', 'manager', 'operator', 'worker', 'viewer'],
  top_manager: ['top_manager', 'manager', 'operator', 'viewer'],
  manager: ['manager', 'operator', 'viewer'],
  operator: ['operator', 'viewer'],
  worker: ['worker', 'viewer'],
  viewer: ['viewer'],
} as const satisfies Record<UserRole, readonly UserRole[]>;

export function isUserRole(value: unknown): value is UserRole {
  return typeof value === 'string' && USER_ROLES.includes(value as UserRole);
}

export function mapRoleIdToRole(roleId: number): UserRole | null {
  return ROLE_ID_TO_ROLE[roleId as KnownRoleId] ?? null;
}

export function getPermissionsForRole(role: UserRole): readonly PermissionName[] {
  return ROLE_PERMISSIONS[role];
}

export function can(role: UserRole, permission: PermissionName): boolean {
  return (ROLE_PERMISSIONS[role] as readonly PermissionName[]).includes(permission);
}
