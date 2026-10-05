import type { AuthorizationPolicyScopes } from '../../types/auth';

export type UserRole =
  | 'superadmin'
  | 'admin'
  | 'manager'
  | 'operator'
  | 'top_manager'
  | 'worker'
  | 'packer'
  | 'viewer'
  | 'onec_operator'
  | string;

export type PermissionName =
  | 'message_signals.view'
  | 'message_signals.resolve'
  | 'message_signals.technical'
  | 'message_signals.manage_config'
  | 'orders.view'
  | 'orders.create'
  | 'orders.update'
  | 'orders.delete'
  | 'orders.export'
  | 'orders.import'
  | 'orders.change_status'
  | 'orders.view_financials'
  | 'payments.view'
  | 'payments.create'
  | 'payments.update'
  | 'payments.delete'
  | 'users.view'
  | 'users.create'
  | 'users.update'
  | 'users.change_password'
  | 'users.deactivate'
  | 'users.activate'
  | 'users.manage_sso'
  | 'employees.view'
  | 'employees.manage'
  | 'references.view'
  | 'references.manage'
  | 'finance.analytics.view'
  | 'payments.onec.view'
  | 'payments.onec.manage'
  | 'clients.analytics.view'
  | 'vlm.use'
  | 'vlm.configure'
  | 'settings.view'
  | 'settings.manage'
  | 'audit.view'
  | 'audit.technical.view'
  | 'cut.view'
  | 'cad.view'
  | 'cad.edit'
  | 'cad.export'
  | 'cad.technology'
  | 'cad.approve'
  | 'cut.manage'
  | 'cnc.telegram_import.manage_all'
  | 'sheet_materials.view'
  | 'sheet_materials.manage'
  | 'labels.view'
  | 'labels.manage_templates'
  | 'labels.generate'
  | 'doweling.create'
  | 'procurement.view'
  | 'procurement.manage'
  | 'inventory.view'
  | 'inventory.manage'
  | 'finance.view'
  | 'suppliers.view'
  | 'suppliers.manage'
  | 'vendors.view'
  | 'vendors.manage'
  | 'clients.view'
  | 'clients.update'
  | string;

export interface BackendUserIdentity {
  id: string;
  username: string;
  role: UserRole;
  roleId?: number;
  permissions: PermissionName[];
  permissionsVersion: number;
  policyScopes: AuthorizationPolicyScopes;
}

export interface LoginRequest {
  username: string;
  password: string;
}

export interface LoginResponse {
  accessToken: string;
  accessTokenExpiresAt?: string;
  user: BackendUserIdentity;
}

export interface RefreshResponse {
  accessToken: string;
  accessTokenExpiresAt?: string;
  user: BackendUserIdentity;
}

export interface LogoutResponse {
  ok: true;
  /** Hosted provider logout URL; present when the session came from SSO. */
  providerLogoutUrl?: string;
  /**
   * 'redirect' — follow providerLogoutUrl; 'unavailable' — SSO session but
   * the provider logout could not be prepared (provider session may still be
   * alive, show a warning); 'not_applicable' — plain local session.
   */
  providerLogoutStatus?: 'redirect' | 'unavailable' | 'not_applicable';
}

export interface MeResponse {
  user: BackendUserIdentity;
}
