import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../api/apiError';
import { makeOrderDeleteHandler } from './orderDeleteAction';

describe('makeOrderDeleteHandler', () => {
  it('calls deleteFn then onSuccess', async () => {
    const deleteFn = vi.fn().mockResolvedValue(undefined);
    const onSuccess = vi.fn();
    const onVersionConflict = vi.fn();
    const onError = vi.fn();

    const handler = makeOrderDeleteHandler({
      deleteFn,
      onSuccess,
      onVersionConflict,
      onError,
    });

    await handler();

    expect(deleteFn).toHaveBeenCalledTimes(1);
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(onVersionConflict).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('routes ORDER_VERSION_CONFLICT to onVersionConflict', async () => {
    const deleteFn = vi.fn().mockRejectedValue(
      new ApiError({
        code: 'ORDER_VERSION_CONFLICT',
        message: 'Conflict',
        status: 409,
      }),
    );
    const onSuccess = vi.fn();
    const onVersionConflict = vi.fn();
    const onError = vi.fn();

    const handler = makeOrderDeleteHandler({
      deleteFn,
      onSuccess,
      onVersionConflict,
      onError,
    });

    await handler();

    expect(onVersionConflict).toHaveBeenCalledTimes(1);
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('routes other errors to onError with message', async () => {
    const deleteFn = vi.fn().mockRejectedValue(new Error('custom failure'));
    const onSuccess = vi.fn();
    const onVersionConflict = vi.fn();
    const onError = vi.fn();

    const handler = makeOrderDeleteHandler({
      deleteFn,
      onSuccess,
      onVersionConflict,
      onError,
    });

    await handler();

    expect(onError).toHaveBeenCalledWith('custom failure');
    expect(onSuccess).not.toHaveBeenCalled();
    expect(onVersionConflict).not.toHaveBeenCalled();
  });
});
