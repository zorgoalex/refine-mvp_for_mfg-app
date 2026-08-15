import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../common/errors/api-error';
import type { RequestWithCurrentUser } from '../permissions/current-user';
import { PerformanceController } from './performance.controller';

function createController() {
  const rum = {
    accept: vi.fn(),
    snapshot: vi.fn().mockReturnValue({ source: 'performance-rum-sink', series: [] }),
  };
  const queries = {
    snapshot: vi.fn().mockReturnValue({ source: 'app-query-histogram', series: [] }),
  };
  return {
    controller: new PerformanceController(rum as never, queries as never),
    rum,
    queries,
  };
}

function request(permissions: string[]): RequestWithCurrentUser {
  return {
    requestId: 'req-performance-test',
    user: {
      id: 7,
      username: 'performance-reviewer',
      role: 'admin',
      permissions,
    },
  } as RequestWithCurrentUser;
}

describe('PerformanceController summary authorization', () => {
  it('requires an authenticated user', () => {
    const { controller } = createController();

    expect(() => controller.rumSummary({} as RequestWithCurrentUser)).toThrowError(
      expect.objectContaining<Partial<ApiError>>({ statusCode: 401, code: 'AUTHENTICATION_REQUIRED' }),
    );
  });

  it('does not treat the admin role as a permission wildcard', () => {
    const { controller } = createController();

    expect(() => controller.histograms(request(['orders.view']))).toThrowError(
      expect.objectContaining<Partial<ApiError>>({ statusCode: 403, code: 'PERMISSION_DENIED' }),
    );
  });

  it('allows literal system.health.view permission for both summaries', () => {
    const { controller, rum, queries } = createController();
    const reviewer = request(['system.health.view']);

    expect(controller.histograms(reviewer)).toEqual({ source: 'app-query-histogram', series: [] });
    expect(controller.rumSummary(reviewer)).toEqual({ source: 'performance-rum-sink', series: [] });
    expect(queries.snapshot).toHaveBeenCalledTimes(1);
    expect(rum.snapshot).toHaveBeenCalledTimes(1);
  });
});
