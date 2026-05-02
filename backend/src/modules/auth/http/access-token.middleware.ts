import { Inject, Injectable, NestMiddleware } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NextFunction, Request, Response } from 'express';
import type { BackendEnv } from '../../../config/env.validation';
import type { RequestWithCurrentUser } from '../../../permissions/current-user';
import { JwtAccessTokenIssuer } from '../adapters/jwt-access-token-issuer';

type AuthenticatedRequest = Request & RequestWithCurrentUser;

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

    request.user = this.verifier.verifyAccessToken(token);
    next();
  }
}
