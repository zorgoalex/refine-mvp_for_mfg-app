/**
 * Hasura role of an ERP role in the access token (access groups 0Б, plan report 2026-10-13 §2). `admin` is Hasura's
 * built-in superuser role that ignores every permission rule, so the ERP administrator gets the ordinary role
 * `erp_admin`, whose permissions follow the user's effective permissions like every other role.
 */
export const HASURA_ADMIN_ROLE = 'erp_admin';

export function hasuraRoleForErpRole(role: string): string {
  return role === 'admin' ? HASURA_ADMIN_ROLE : role;
}
