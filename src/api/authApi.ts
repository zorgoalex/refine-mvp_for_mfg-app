import { authSession } from './authSession';
import { apiRoutes } from './apiRoutes';
import { httpClient } from './httpClient';
import type {
  LoginRequest,
  LoginResponse,
  LogoutResponse,
  MeResponse,
  RefreshResponse,
} from './types/authApi.types';

export const authApi = {
  async login(credentials: LoginRequest): Promise<LoginResponse> {
    const response = await httpClient.post<LoginResponse>(apiRoutes.auth.login, credentials, {
      skipAuthRefresh: true,
    });
    setSessionFromAuthResponse(response);
    return response;
  },

  async refresh(): Promise<RefreshResponse> {
    const response = await httpClient.post<RefreshResponse>(apiRoutes.auth.refresh, undefined, {
      skipAuthRefresh: true,
    });
    setSessionFromAuthResponse(response);
    return response;
  },

  async logout(): Promise<LogoutResponse> {
    try {
      return await httpClient.post<LogoutResponse>(apiRoutes.auth.logout, undefined, {
        skipAuthRefresh: true,
      });
    } finally {
      authSession.clear();
    }
  },

  async me(): Promise<MeResponse> {
    const response = await httpClient.get<MeResponse>(apiRoutes.auth.me);
    authSession.setUser(response.user);
    return response;
  },
};

function setSessionFromAuthResponse(response: LoginResponse | RefreshResponse): void {
  authSession.setAccessToken(response.accessToken);
  authSession.setUser(response.user);
}
