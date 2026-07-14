import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../api/apiError';
import { makeRestoreHandler } from './orderRestoreAction';

describe('makeRestoreHandler', () => {
  it('restores with current version and calls onRestored', async () => {
    const restoreFn = vi.fn().mockResolvedValue(undefined);
    const confirmFn = vi.fn().mockResolvedValue(true);
    const notify = { success: vi.fn(), warning: vi.fn(), error: vi.fn() };
    const onRestored = vi.fn();
    const onStale = vi.fn();

    const handler = makeRestoreHandler({
      restoreFn,
      confirmFn,
      notify,
      onRestored,
      onStale,
    });

    await handler(7);

    expect(restoreFn).toHaveBeenCalledTimes(1);
    expect(restoreFn).toHaveBeenCalledWith(
      expect.objectContaining({
        version: 7,
        idempotencyKey: expect.stringMatching(/^order-restore:/),
      }),
    );
    expect(notify.success).toHaveBeenCalledWith('Заказ восстановлен');
    expect(onRestored).toHaveBeenCalledTimes(1);
    expect(onStale).not.toHaveBeenCalled();
    expect(confirmFn).not.toHaveBeenCalled();
  });

  it('on ORDER_NAME_DUPLICATE asks confirm and retries with suggested name and a FRESH idempotency key', async () => {
    const duplicate = new ApiError({
      code: 'ORDER_NAME_DUPLICATE',
      message: 'Номер занят',
      status: 409,
      details: { existingOrderId: 19, suggestedOrderName: '2561' },
    });
    const restoreFn = vi
      .fn()
      .mockRejectedValueOnce(duplicate)
      .mockResolvedValueOnce(undefined);
    const confirmFn = vi.fn().mockResolvedValue(true);
    const notify = { success: vi.fn(), warning: vi.fn(), error: vi.fn() };
    const onRestored = vi.fn();
    const onStale = vi.fn();

    const handler = makeRestoreHandler({
      restoreFn,
      confirmFn,
      notify,
      onRestored,
      onStale,
    });

    await handler(9);

    expect(confirmFn).toHaveBeenCalledWith('Номер занят заказом #19. Восстановить как 2561?');
    expect(restoreFn).toHaveBeenCalledTimes(2);
    expect(restoreFn.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        version: 9,
        idempotencyKey: expect.stringMatching(/^order-restore:/),
      }),
    );
    expect(restoreFn.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        version: 9,
        orderName: '2561',
        idempotencyKey: expect.stringMatching(/^order-restore:/),
      }),
    );
    expect(restoreFn.mock.calls[1]?.[0]?.idempotencyKey).not.toBe(
      restoreFn.mock.calls[0]?.[0]?.idempotencyKey,
    );
    expect(notify.success).toHaveBeenCalledWith('Заказ восстановлен как 2561');
    expect(onRestored).toHaveBeenCalledTimes(1);
    expect(onStale).not.toHaveBeenCalled();
  });

  it('on duplicate without suggestion only notifies', async () => {
    const restoreFn = vi.fn().mockRejectedValue(
      new ApiError({
        code: 'ORDER_NAME_DUPLICATE',
        message: 'Номер занят',
        status: 409,
        details: { existingOrderId: 21, suggestedOrderName: null },
      }),
    );
    const confirmFn = vi.fn().mockResolvedValue(true);
    const notify = { success: vi.fn(), warning: vi.fn(), error: vi.fn() };
    const onRestored = vi.fn();
    const onStale = vi.fn();

    const handler = makeRestoreHandler({
      restoreFn,
      confirmFn,
      notify,
      onRestored,
      onStale,
    });

    await handler(4);

    expect(notify.warning).toHaveBeenCalledWith(
      'Номер занят заказом #21, свободный номер недоступен',
    );
    expect(confirmFn).not.toHaveBeenCalled();
    expect(restoreFn).toHaveBeenCalledTimes(1);
    expect(onRestored).not.toHaveBeenCalled();
    expect(onStale).not.toHaveBeenCalled();
  });

  it('on ORDER_NOT_DELETED refreshes silently', async () => {
    const restoreFn = vi.fn().mockRejectedValue(
      new ApiError({
        code: 'ORDER_NOT_DELETED',
        message: 'Уже восстановлен',
        status: 409,
      }),
    );
    const notify = { success: vi.fn(), warning: vi.fn(), error: vi.fn() };
    const onRestored = vi.fn();
    const onStale = vi.fn();

    const handler = makeRestoreHandler({
      restoreFn,
      confirmFn: vi.fn().mockResolvedValue(true),
      notify,
      onRestored,
      onStale,
    });

    await handler(5);

    expect(onStale).toHaveBeenCalledTimes(1);
    expect(onRestored).not.toHaveBeenCalled();
    expect(notify.success).not.toHaveBeenCalled();
    expect(notify.warning).not.toHaveBeenCalled();
    expect(notify.error).not.toHaveBeenCalled();
  });

  it('on ORDER_VERSION_CONFLICT notifies conflict', async () => {
    const restoreFn = vi.fn().mockRejectedValue(
      new ApiError({
        code: 'ORDER_VERSION_CONFLICT',
        message: 'Версия устарела',
        status: 409,
      }),
    );
    const notify = { success: vi.fn(), warning: vi.fn(), error: vi.fn() };
    const onRestored = vi.fn();
    const onStale = vi.fn();

    const handler = makeRestoreHandler({
      restoreFn,
      confirmFn: vi.fn().mockResolvedValue(true),
      notify,
      onRestored,
      onStale,
    });

    await handler(6);

    expect(notify.error).toHaveBeenCalledWith('Данные устарели, обновите список');
    expect(onStale).toHaveBeenCalledTimes(1);
    expect(onRestored).not.toHaveBeenCalled();
  });

  it('on ORDER_RESTORE_CONFLICT notifies retry and refreshes', async () => {
    const restoreFn = vi.fn().mockRejectedValue(
      new ApiError({
        code: 'ORDER_RESTORE_CONFLICT',
        message: 'Конкурентное изменение',
        status: 409,
      }),
    );
    const notify = { success: vi.fn(), warning: vi.fn(), error: vi.fn() };
    const onRestored = vi.fn();
    const onStale = vi.fn();

    const handler = makeRestoreHandler({
      restoreFn,
      confirmFn: vi.fn().mockResolvedValue(true),
      notify,
      onRestored,
      onStale,
    });

    await handler(8);

    expect(notify.error).toHaveBeenCalledWith('Конкурентное изменение, повторите попытку');
    expect(onStale).toHaveBeenCalledTimes(1);
    expect(onRestored).not.toHaveBeenCalled();
  });
});
