import type { CurrentUser } from '../../../permissions/current-user';
import type { LoginResult } from '../auth.types';

export const AUTH_SESSION_HTTP_PORT = Symbol('AUTH_SESSION_HTTP_PORT');

export interface RefreshCommand {
  refreshToken: string;
  userAgent?: string;
  ipAddress?: string;
  requestId?: string;
}

export interface LogoutCommand {
  refreshToken?: string;
  currentUser?: CurrentUser;
  requestId?: string;
  userAgent?: string;
  ipAddress?: string;
}

export interface AuthSessionHttpPort {
  refresh(command: RefreshCommand): Promise<LoginResult>;
  logout(command: LogoutCommand): Promise<void>;
}
