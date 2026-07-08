import { Inject, Injectable, NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NextFunction, Request, Response } from 'express';
import type { BackendEnv } from '../../../config/env.validation';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { JwtAccessTokenIssuer } from '../adapters/jwt-access-token-issuer';

type AuthenticatedRequest = Request & RequestWithCurrentUser;

// Routes that authenticate via the HttpOnly refresh cookie, where a stale
// bearer (idle tab whose access token expired) must degrade to anonymous
// instead of 401 — otherwise refresh/logout die before the cookie is read
// and the client force-logs-out a session whose cookie is still alive.
const COOKIE_AUTHENTICATED_POSTS = new Set(['/api/v1/auth/refresh', '/api/v1/auth/logout']);

function isCookieAuthenticatedPost(request: Request): boolean {
  if (request.method !== 'POST') {
    return false;
  }
  const path = (request.originalUrl ?? request.url ?? '').split('?')[0];
  return COOKIE_AUTHENTICATED_POSTS.has(path);
}

@Injectable()
export class AccessTokenMiddleware implements NestMiddleware {
  private readonly verifier: JwtAccessTokenIssuer | null;

  constructor(@Inject(ConfigService) config: ConfigService<BackendEnv, true>) {
    const secret = config.get('JWT_ACCESS_SECRET', { infer: true });
    this.verifier = secret
      ? new JwtAccessTokenIssuer(secret, config.get('ACCESS_TOKEN_TTL_SECONDS', { infer: true }))
      : null;
  }

  use(request: AuthenticatedRequest, _response: Response, next: NextFunction): void {
    const authorization = request.headers.authorization;

    if (!authorization) {
      next();
      return;
    }

    const [scheme, token] = authorization.split(' ');

    if (scheme?.toLowerCase() !== 'bearer' || !token || !this.verifier) {
      next();
      return;
    }

    try {
      request.user = this.verifier.verifyAccessToken(token);
    } catch (error) {
      if (isCookieAuthenticatedPost(request)) {
        next();
        return;
      }
      throw error;
    }
    next();
  }
}
