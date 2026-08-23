import { authSession } from './authSession';
import { ApiError } from './apiError';
import { apiRoutes } from './apiRoutes';
import { httpClient, refreshAuthSession } from './httpClient';
import type {
  LoginRequest,
  LoginResponse,
  LogoutResponse,
  MeResponse,
  RefreshResponse,
} from './types/authApi.types';

export type WorkosLinkItem = {
  identityId: string;
  authMethod: string | null;
  emailAtLink: string;
  linkedAt: string;
  lastLoginAt: string | null;
};

export type WorkosLoginPolicy = 'local' | 'external' | 'both';

export type WorkosUserSettings = {
  loginPolicy: WorkosLoginPolicy;
  selfLinkEnabled: boolean;
  selfUnlinkEnabled: boolean;
};

export const authApi = {
  async login(credentials: LoginRequest): Promise<LoginResponse> {
    const response = await httpClient.post<LoginResponse>(apiRoutes.auth.login, credentials, {
      skipAuthRefresh: true,
    });
    setSessionFromAuthResponse(response);
    return response;
  },

  async refresh(): Promise<RefreshResponse> {
    return refreshAuthSession();
  },

  // Local state is cleared only on a CONFIRMED backend logout: on failure
  // the HttpOnly refresh cookie is still alive, so pretending to be logged
  // out (dropping the in-memory session) would be a lie on a shared machine.
  async logout(): Promise<LogoutResponse> {
    const response = await httpClient.post<LogoutResponse>(apiRoutes.auth.logout, undefined, {
      skipAuthRefresh: true,
    });
    authSession.clear();
    return response;
  },

  async me(): Promise<MeResponse> {
    const sessionVersionAtStart = authSession.getAccessTokenVersion();
    const sessionGenerationAtStart = authSession.getSessionGeneration();
    const response = await httpClient.get<MeResponse>(apiRoutes.auth.me);

    // /me may finish after logout, login as another actor, or transparent
    // refresh. Never publish its older identity into the newer session.
    if (
      authSession.getAccessTokenVersion() !== sessionVersionAtStart
      || authSession.getSessionGeneration() !== sessionGenerationAtStart
    ) {
      const currentAccessToken = authSession.getAccessToken();
      const currentUser = authSession.getUser();
      if (currentAccessToken && currentUser) return { user: currentUser as MeResponse['user'] };
      throw new ApiError({
        code: 'AUTH_ME_SUPERSEDED',
        message: 'Загрузка пользователя отменена более новым состоянием сессии',
        status: 409,
      });
    }

    if (!authSession.getAccessToken()) {
      throw new ApiError({
        code: 'AUTH_ME_SUPERSEDED',
        message: 'Загрузка пользователя отменена завершением сессии',
        status: 409,
      });
    }
    authSession.setUser(response.user);
    return response;
  },

  // Hybrid SSO (WorkOS AuthKit). Both callback helpers MUST keep
  // skipAuthRefresh: true — the httpClient otherwise refreshes on 401 and
  // replays the request, which burns the single-use authorization code and
  // turns meaningful 401s into a false invalid_grant.
  async workosAuthorizeUrl(options: { selectAccount?: boolean } = {}): Promise<string> {
    const endpoint = options.selectAccount
      ? `${apiRoutes.auth.workosAuthorize}?select_account=1`
      : apiRoutes.auth.workosAuthorize;
    const response = await httpClient.get<{ url: string }>(endpoint, {
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

  async workosInvitationStartUrl(token: string): Promise<string> {
    const response = await httpClient.post<{ url: string }>(
      apiRoutes.auth.workosInvitationStart,
      { token },
      { skipAuthRefresh: true },
    );
    return response.url;
  },

  async workosInvitationCallback(code: string, state: string): Promise<{ linked: true }> {
    return httpClient.post<{ linked: true }>(
      apiRoutes.auth.workosInvitationCallback,
      { code, state },
      { skipAuthRefresh: true },
    );
  },

  async workosListLinks(): Promise<{ links: WorkosLinkItem[] }> {
    return httpClient.get<{ links: WorkosLinkItem[] }>(apiRoutes.auth.workosLinks);
  },

  async workosGetSettings(): Promise<WorkosUserSettings> {
    return httpClient.get<WorkosUserSettings>(apiRoutes.auth.workosSettings);
  },

  // skipAuthRefresh: a wrong password comes back as a business 401 and the
  // generic refresh-replay would fire a SECOND DELETE (double limiter hit).
  // The caller refreshes the session explicitly before submitting.
  async workosUnlinkOne(identityId: string, password: string): Promise<{ unlinked: boolean }> {
    return httpClient.delete<{ unlinked: boolean }>(apiRoutes.auth.workosLinkById(identityId), {
      body: JSON.stringify({ password }),
      headers: { 'Content-Type': 'application/json' },
      skipAuthRefresh: true,
    });
  },

  async workosAdminListLinks(userId: string): Promise<{ links: WorkosLinkItem[] }> {
    return httpClient.get<{ links: WorkosLinkItem[] }>(apiRoutes.auth.workosAdminLinks(userId));
  },

  async workosAdminGetSettings(userId: string): Promise<WorkosUserSettings> {
    return httpClient.get<WorkosUserSettings>(apiRoutes.auth.workosAdminSettings(userId));
  },

  async workosAdminUpdateSettings(
    userId: string,
    settings: WorkosUserSettings,
  ): Promise<WorkosUserSettings> {
    return httpClient.patch<WorkosUserSettings>(
      apiRoutes.auth.workosAdminSettings(userId),
      settings,
    );
  },

  async workosAdminCreateInvitation(
    userId: string,
  ): Promise<{ invitationUrl: string; expiresAt: string }> {
    return httpClient.post<{ invitationUrl: string; expiresAt: string }>(
      apiRoutes.auth.workosAdminInvitations(userId),
      undefined,
    );
  },

  async workosAdminRevokeInvitations(userId: string): Promise<{ revoked: boolean }> {
    return httpClient.delete<{ revoked: boolean }>(
      apiRoutes.auth.workosAdminInvitations(userId),
      { skipAuthRefresh: true },
    );
  },

  // skipAuthRefresh: admin unlink is destructive too, so a 401 must never
  // auto-refresh and replay the DELETE for the same identity.
  async workosAdminUnlinkOne(
    userId: string,
    identityId: string,
    reason?: string,
  ): Promise<{ unlinked: boolean }> {
    return httpClient.delete<{ unlinked: boolean }>(
      apiRoutes.auth.workosAdminLinkById(userId, identityId),
      {
        body: JSON.stringify({ reason }),
        headers: { 'Content-Type': 'application/json' },
        skipAuthRefresh: true,
      },
    );
  },
};

function setSessionFromAuthResponse(response: LoginResponse | RefreshResponse): void {
  authSession.setAccessToken(response.accessToken);
  authSession.setUser(response.user);
}
