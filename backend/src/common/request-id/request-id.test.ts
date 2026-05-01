import { describe, expect, it } from 'vitest';
import { getOrCreateRequestId, normalizeRequestId } from './request-id';
import { createRequestIdMiddleware } from './request-id.middleware';

describe('requestId helper and middleware', () => {
  it('accepts safe incoming request ids', () => {
    expect(normalizeRequestId('req_existing-123')).toBe('req_existing-123');
    expect(normalizeRequestId(' bad id ')).toBeNull();
  });

  it('creates request id when incoming value is missing', () => {
    expect(getOrCreateRequestId(undefined)).toMatch(/^req_[0-9a-f-]{36}$/);
  });

  it('stores and echoes configured request id header', () => {
    const req = {
      headers: {
        'x-correlation-id': 'req_existing-123',
      },
      requestId: undefined as string | undefined,
    };
    const headers: Record<string, string> = {};
    const res = {
      setHeader(name: string, value: string) {
        headers[name] = value;
      },
    };
    let called = false;

    createRequestIdMiddleware('X-Correlation-Id')(req, res, () => {
      called = true;
    });

    expect(req.requestId).toBe('req_existing-123');
    expect(headers['x-correlation-id']).toBe('req_existing-123');
    expect(called).toBe(true);
  });
});
