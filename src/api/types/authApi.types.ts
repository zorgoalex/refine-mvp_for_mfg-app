export type UserRole =
  | 'superadmin'
  | 'admin'
  | 'manager'
  | 'operator'
  | 'top_manager'
  | 'worker'
  | 'viewer'
  | string;

export type PermissionName =
  | 'orders.view'
  | 'orders.create'
  | 'orders.update'
  | 'orders.delete'
  | 'orders.export'
  | 'orders.import'
  | 'orders.change_status'
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
  | 'references.view'
  | 'references.manage'
  | 'analytics.view'
  | 'vlm.use'
  | 'vlm.configure'
  | 'settings.view'
  | 'settings.manage'
  | 'audit.view'
  | 'cut.view'
  | 'cut.manage'
  | 'sheet_materials.view'
  | 'sheet_materials.manage'
  | 'labels.view'
  | 'labels.manage_templates'
  | 'labels.generate'
  | 'doweling.create'
  | string;

export interface BackendUserIdentity {
  id: string;
  username: string;
  role: UserRole;
  roleId?: number;
  permissions: PermissionName[];
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
