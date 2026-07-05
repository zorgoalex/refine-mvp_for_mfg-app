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

  // Hybrid SSO (WorkOS AuthKit). Both callback helpers MUST keep
  // skipAuthRefresh: true — the httpClient otherwise refreshes on 401 and
  // replays the request, which burns the single-use authorization code and
  // turns meaningful 401s into a false invalid_grant.
  async workosAuthorizeUrl(): Promise<string> {
    const response = await httpClient.get<{ url: string }>(apiRoutes.auth.workosAuthorize, {
      skipAuthRefresh: true,
    });
    return response.url;
  },

  async workosCallback(code: string, state: string): Promise<LoginResponse> {
    const response = await httpClient.post<LoginResponse>(
      apiRoutes.auth.workosCallback,
      { code, state },
      { skipAuthRefresh: true },
    );
    setSessionFromAuthResponse(response);
    return response;
  },

  async workosLinkStartUrl(): Promise<string> {
    const response = await httpClient.post<{ url: string }>(apiRoutes.auth.workosLinkStart, undefined);
    return response.url;
  },

  async workosLinkCallback(code: string, state: string): Promise<{ linked: true }> {
    return httpClient.post<{ linked: true }>(
      apiRoutes.auth.workosLinkCallback,
      { code, state },
      { skipAuthRefresh: true },
    );
  },

  async workosLinkStatus(): Promise<{ linked: boolean }> {
    return httpClient.get<{ linked: boolean }>(apiRoutes.auth.workosLink);
  },

  // skipAuthRefresh: a wrong password comes back as a business 401 and the
  // generic refresh-replay would fire a SECOND DELETE (double limiter hit).
  // The caller refreshes the session explicitly before submitting.
  async workosUnlink(password: string): Promise<{ unlinked: boolean }> {
    return httpClient.delete<{ unlinked: boolean }>(apiRoutes.auth.workosLink, {
      body: JSON.stringify({ password }),
      headers: { 'Content-Type': 'application/json' },
      skipAuthRefresh: true,
    });
  },
};

function setSessionFromAuthResponse(response: LoginResponse | RefreshResponse): void {
  authSession.setAccessToken(response.accessToken);
  authSession.setUser(response.user);
}
