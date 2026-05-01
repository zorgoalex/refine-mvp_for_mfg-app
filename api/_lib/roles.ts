export const ROLE_ID_TO_SYSTEM_ROLE: Record<number, string> = {
  1: 'admin',
  2: 'superadmin',
  10: 'manager',
  11: 'operator',
  15: 'top_manager',
  20: 'worker',
  100: 'viewer',
};

export const ROLE_HIERARCHY: Record<string, string[]> = {
  superadmin: ['superadmin', 'admin', 'top_manager', 'manager', 'operator', 'worker', 'viewer'],
  admin: ['admin', 'manager', 'operator', 'top_manager', 'worker', 'viewer'],
  manager: ['manager', 'operator', 'viewer'],
  top_manager: ['top_manager', 'manager', 'operator', 'viewer'],
  operator: ['operator', 'viewer'],
  worker: ['worker', 'viewer'],
  viewer: ['viewer'],
};

export function mapRoleIdToSystemRole(roleId: number): string {
  return ROLE_ID_TO_SYSTEM_ROLE[roleId] || 'viewer';
}

export function getAllowedRoles(systemRole: string): string[] {
  return ROLE_HIERARCHY[systemRole] || ['viewer'];
}
