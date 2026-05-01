import { describe, expect, it } from 'vitest';
import { ApiError, createInternalError, formatApiError } from './api-error';

describe('ApiError contract', () => {
  it('formats stable error response with details and requestId', () => {
    const error = new ApiError(403, 'PERMISSION_DENIED', 'Недостаточно прав', {
      requiredPermission: 'orders.update',
    });

    expect(formatApiError(error, 'req_test')).toEqual({
      error: {
        code: 'PERMISSION_DENIED',
        message: 'Недостаточно прав',
        details: {
          requiredPermission: 'orders.update',
        },
        requestId: 'req_test',
      },
    });
  });

  it('does not include empty details', () => {
    expect(formatApiError(new ApiError(404, 'RESOURCE_NOT_FOUND', 'Not found'), 'req_404')).toEqual({
      error: {
        code: 'RESOURCE_NOT_FOUND',
        message: 'Not found',
        requestId: 'req_404',
      },
    });
  });

  it('formats generic internal errors without leaking details', () => {
    expect(createInternalError('req_internal')).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
        requestId: 'req_internal',
      },
    });
  });
});
