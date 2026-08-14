import jwt, { TokenExpiredError } from 'jsonwebtoken';
import { ApiError } from '../../../common/errors/api-error';
import type { BackendEnv } from '../../../config/env.validation';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName, UserRole } from '../../../permissions/permissions';
import type { RolePolicy } from '../../../permissions/policies/role-policies';
import type { AccessTokenIssuerPort, IssuedAccessToken } from '../auth.types';

export interface AccessTokenPayload {
  sub: string;
  iat: number;
  username: string;
  role: UserRole;
  roleId: number;
  permissions: PermissionName[];
  policyScopes?: RolePolicy;
  permissionsVersion?: number;
  sessionId?: string;
  tokenType: 'access';
  'https://hasura.io/jwt/claims': {
    'x-hasura-allowed-roles': string[];
    'x-hasura-default-role': string;
    'x-hasura-user-id': string;
  };
}

export class JwtAccessTokenIssuer implements AccessTokenIssuerPort {
  constructor(
    private readonly secret: string,
    private readonly ttlSeconds: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async issueAccessToken(
    user: CurrentUser,
    options: { notAfter?: Date } = {},
  ): Promise<IssuedAccessToken> {
    const now = this.now();
    const configuredExpiresAt = new Date(now.getTime() + this.ttlSeconds * 1000);
    const expiresAt =
      options.notAfter && options.notAfter.getTime() < configuredExpiresAt.getTime()
        ? options.notAfter
        : configuredExpiresAt;
    const expiresInSeconds = Math.floor((expiresAt.getTime() - now.getTime()) / 1000);

    if (options.notAfter && expiresInSeconds <= 0) {
      throw new ApiError(401, 'ACCESS_TOKEN_SESSION_EXPIRED', 'Auth session expired');
    }

    const payload: AccessTokenPayload = {
      sub: user.id,
      iat: Math.floor(now.getTime() / 1000),
      username: user.username,
      role: user.role,
      roleId: user.roleId,
      permissions: [...user.permissions],
      policyScopes: user.policyScopes,
      permissionsVersion: user.permissionsVersion,
      sessionId: user.sessionId,
      tokenType: 'access',
      'https://hasura.io/jwt/claims': {
        'x-hasura-allowed-roles': [user.role],
        'x-hasura-default-role': user.role,
        'x-hasura-user-id': user.id,
      },
    };
    const accessToken = jwt.sign(payload, this.secret, {
      algorithm: 'HS256',
      expiresIn: expiresInSeconds,
    });

    return {
      accessToken,
      expiresAt: new Date(now.getTime() + expiresInSeconds * 1000),
    };
  }

  verifyAccessToken(accessToken: string): CurrentUser {
    try {
      const payload = jwt.verify(accessToken, this.secret, {
        clockTimestamp: Math.floor(this.now().getTime() / 1000),
      }) as AccessTokenPayload;

      if (payload.tokenType !== 'access') {
        throw new ApiError(401, 'ACCESS_TOKEN_INVALID', 'Access token is invalid');
      }

      return {
        id: payload.sub,
        username: payload.username,
        role: payload.role,
        roleId: payload.roleId,
        permissions: payload.permissions,
        policyScopes: payload.policyScopes,
        permissionsVersion: payload.permissionsVersion,
        sessionId: payload.sessionId,
      };
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }

      if (error instanceof TokenExpiredError) {
        throw new ApiError(401, 'ACCESS_TOKEN_EXPIRED', 'Access token expired');
      }

      throw new ApiError(401, 'ACCESS_TOKEN_INVALID', 'Access token is invalid');
    }
  }
}

export function createJwtAccessTokenIssuerFromEnv(env: Pick<
  BackendEnv,
  'JWT_ACCESS_SECRET' | 'ACCESS_TOKEN_TTL_SECONDS'
>): JwtAccessTokenIssuer | null {
  if (!env.JWT_ACCESS_SECRET) {
    return null;
  }

  return new JwtAccessTokenIssuer(env.JWT_ACCESS_SECRET, env.ACCESS_TOKEN_TTL_SECONDS);
}
