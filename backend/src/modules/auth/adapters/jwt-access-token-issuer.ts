import jwt, { TokenExpiredError } from 'jsonwebtoken';
import { ApiError } from '../../../common/errors/api-error';
import type { BackendEnv } from '../../../config/env.validation';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionName, UserRole } from '../../../permissions/permissions';
import type { AccessTokenIssuerPort, IssuedAccessToken } from '../auth.types';

export interface AccessTokenPayload {
  sub: string;
  username: string;
  role: UserRole;
  roleId: number;
  permissions: PermissionName[];
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

  issueAccessToken(user: CurrentUser): Promise<IssuedAccessToken> {
    const payload: AccessTokenPayload = {
      sub: user.id,
      username: user.username,
      role: user.role,
      roleId: user.roleId,
      permissions: [...user.permissions],
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
      expiresIn: this.ttlSeconds,
    });

    return Promise.resolve({
      accessToken,
      expiresAt: new Date(this.now().getTime() + this.ttlSeconds * 1000),
    });
  }

  verifyAccessToken(accessToken: string): CurrentUser {
    try {
      const payload = jwt.verify(accessToken, this.secret) as AccessTokenPayload;

      if (payload.tokenType !== 'access') {
        throw new ApiError(401, 'ACCESS_TOKEN_INVALID', 'Access token is invalid');
      }

      return {
        id: payload.sub,
        username: payload.username,
        role: payload.role,
        roleId: payload.roleId,
        permissions: payload.permissions,
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
