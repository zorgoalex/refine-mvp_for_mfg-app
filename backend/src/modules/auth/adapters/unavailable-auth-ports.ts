import { ApiError } from '../../../common/errors/api-error';
import { AuthService, type AuthServicePorts } from '../auth.service';
import type { AuthSessionHttpPort } from '../http/auth-session-http.port';

function unavailable(): never {
  throw new ApiError(503, 'SERVICE_UNAVAILABLE', 'Auth DB adapter is not configured', {
    module: 'auth',
  });
}

export function createUnavailableAuthService(): AuthService {
  const ports: AuthServicePorts = {
    users: {
      async findByUsername() {
        return unavailable();
      },
    },
    passwords: {
      async verify() {
        return unavailable();
      },
    },
    sessions: {
      async createLoginSession() {
        return unavailable();
      },
    },
    tokens: {
      async issueAccessToken() {
        return unavailable();
      },
    },
    audit: {
      async writeLoginFailed() {
        return unavailable();
      },
    },
  };

  return new AuthService(ports);
}

export class UnavailableAuthSessionHttpPort implements AuthSessionHttpPort {
  async refresh() {
    return unavailable();
  }

  async logout() {
    return unavailable();
  }
}
