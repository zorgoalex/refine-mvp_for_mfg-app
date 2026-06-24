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
}

export interface MeResponse {
  user: BackendUserIdentity;
}
