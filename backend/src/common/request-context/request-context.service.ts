import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { NextFunction, Request, Response } from 'express';

export interface BackendRequestContext {
  requestId: string;
  method: string;
  route: string;
}

interface RequestWithRequestId extends Request {
  requestId?: string;
}

@Injectable()
export class RequestContextService {
  private readonly storage = new AsyncLocalStorage<BackendRequestContext>();

  run<T>(context: BackendRequestContext, callback: () => T): T {
    return this.storage.run(context, callback);
  }

  get(): BackendRequestContext | undefined {
    return this.storage.getStore();
  }
}

export function createRequestContextMiddleware(contexts: RequestContextService) {
  return (request: RequestWithRequestId, _response: Response, next: NextFunction): void => {
    contexts.run(
      {
        requestId: request.requestId ?? 'req_unknown',
        method: request.method.toUpperCase(),
        route: normalizeRequestRoute(request.originalUrl ?? request.url),
      },
      next,
    );
  };
}

export function normalizeRequestRoute(value: string): string {
  const segments = value
    .split('?')[0]
    .slice(0, 256)
    .split('/')
    .filter(Boolean);
  if (segments.length === 0) return '/';

  // Middleware runs before Nest has matched a controller template. Keep only
  // the bounded resource prefix; every deeper segment may be an opaque ID,
  // storage key, file name, config key, or other subject identifier.
  const apiPrefixLength = segments[0] === 'api' && /^v[1-9]\d*$/.test(segments[1] ?? '')
    ? 3
    : 1;
  const safePrefix = segments.slice(0, apiPrefixLength);
  return `/${safePrefix.join('/')}${segments.length > safePrefix.length ? '/*' : ''}`;
}
