import type { VercelRequest, VercelResponse } from '@vercel/node';
import { afterEach, describe, expect, it, vi } from 'vitest';
import loginHandler from './login';
import refreshHandler from './refresh';
import orderExportHandler from './order-export-to-drive';
import usersCreateHandler from './users/create';
import usersChangePasswordHandler from './users/change-password';
import vlmHealthHandler from './vlm/health';
import vlmUploadHandler from './vlm/upload';
import vlmAnalyzeHandler from './vlm/analyze';
import {
  LEGACY_DISABLED_CODE,
  LEGACY_DISABLED_STATUS,
} from './_lib/legacy-production-gate';

describe('legacy Vercel Functions production disable gate', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ['POST /api/login', loginHandler, 'POST'],
    ['POST /api/refresh', refreshHandler, 'POST'],
    ['POST /api/users/create', usersCreateHandler, 'POST'],
    ['POST /api/users/change-password', usersChangePasswordHandler, 'POST'],
    ['POST /api/order-export-to-drive', orderExportHandler, 'POST'],
    ['GET /api/vlm/health', vlmHealthHandler, 'GET'],
    ['POST /api/vlm/upload', vlmUploadHandler, 'POST'],
    ['POST /api/vlm/analyze', vlmAnalyzeHandler, 'POST'],
  ])('disables %s in Vercel production', async (_name, handler, method) => {
    vi.stubEnv('VERCEL_ENV', 'production');
    vi.stubEnv('GAS_API_KEY', 'must-not-leak');
    vi.stubEnv('HASURA_GRAPHQL_ADMIN_SECRET', 'must-not-leak');

    const res = createResponse();

    await handler(
      createRequest(method),
      res as unknown as VercelResponse,
    );

    expect(res.statusCode).toBe(LEGACY_DISABLED_STATUS);
    expect(res.body).toMatchObject({
      error: {
        code: LEGACY_DISABLED_CODE,
        message: 'Legacy Vercel Function is disabled. Use the NestJS backend API.',
        requestId: 'req_disabled_handler',
      },
    });
    expect(JSON.stringify(res.body)).not.toContain('must-not-leak');
  });

  it('does not disable runtime-config in production', async () => {
    vi.stubEnv('VERCEL_ENV', 'production');

    const { default: runtimeConfigHandler } = await import('./runtime-config');
    const res = createResponse();

    runtimeConfigHandler(
      createRequest('GET'),
      res as unknown as VercelResponse,
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      features: {
        backendAuth: false,
        backendOrderExport: false,
        backendUsers: false,
        backendVlm: false,
      },
    });
  });
});

function createRequest(method: string): VercelRequest {
  return {
    method,
    headers: { 'x-request-id': 'req_disabled_handler' },
    body: {},
    socket: { remoteAddress: '127.0.0.1' },
    on: vi.fn(),
  } as unknown as VercelRequest;
}

function createResponse() {
  const response = {
    headers: {} as Record<string, string>,
    statusCode: 0,
    body: undefined as unknown,
    setHeader: vi.fn((key: string, value: string) => {
      response.headers[key] = value;
      return response;
    }),
    status: vi.fn((statusCode: number) => {
      response.statusCode = statusCode;
      return response;
    }),
    json: vi.fn((body: unknown) => {
      response.body = body;
      return response;
    }),
    end: vi.fn(() => response),
  };

  return response;
}
