import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/apiError';
import type { OrderStatusBoardCard } from '../../api/types/orderStatusBoardApi.types';
import {
  classifyOrderStatusBoardMoveFailure,
  executeOrderStatusBoardMove,
  reserveOrderStatusBoardMutation,
  restoreOrderStatusBoardFocus,
} from './interaction';

describe('order status board interactions', () => {
  it('reserves synchronously and rejects a duplicate/concurrent command', () => {
    const reserved = reserveOrderStatusBoardMutation(new Set(), 10);
    expect(reserved).toEqual(new Set([10]));
    expect(reserveOrderStatusBoardMutation(reserved!, 11)).toBeNull();
  });

  it('cancel of production auto-mode performs zero command/refetch requests', async () => {
    const changeOrderStatus = vi.fn();
    const changeProductionStatus = vi.fn();
    const refetch = vi.fn();
    const afterCommand = vi.fn();

    const result = await executeOrderStatusBoardMove(
      {
        board: 'production',
        card: card({ productionStatusFromDetailsEnabled: true }),
        targetStatusId: 7,
        targetName: 'Упаковка',
        idempotencyKey: 'board:test-cancel',
      },
      {
        confirmManualProductionMove: vi.fn().mockResolvedValue(false),
        changeOrderStatus,
        changeProductionStatus,
        afterCommand,
        refetch,
      },
    );

    expect(result).toEqual({ kind: 'cancelled' });
    expect(changeOrderStatus).not.toHaveBeenCalled();
    expect(changeProductionStatus).not.toHaveBeenCalled();
    expect(afterCommand).not.toHaveBeenCalled();
    expect(refetch).not.toHaveBeenCalled();
  });

  it('sends version/idempotency once and reports write-success/refetch-failure as stale', async () => {
    const changeOrderStatus = vi.fn().mockResolvedValue({});
    const afterCommand = vi.fn();
    const refetch = vi.fn().mockResolvedValue(false);
    const currentCard = card({ version: 9 });

    const result = await executeOrderStatusBoardMove(
      {
        board: 'order',
        card: currentCard,
        targetStatusId: 4,
        targetName: 'Готов',
        idempotencyKey: 'board:test-stale',
      },
      {
        confirmManualProductionMove: vi.fn(),
        changeOrderStatus,
        changeProductionStatus: vi.fn(),
        afterCommand,
        refetch,
      },
    );

    expect(changeOrderStatus).toHaveBeenCalledTimes(1);
    expect(changeOrderStatus).toHaveBeenCalledWith(currentCard.orderId, {
      orderStatusId: 4,
      version: 9,
      idempotencyKey: 'board:test-stale',
    });
    expect(afterCommand).toHaveBeenCalledTimes(1);
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ kind: 'stale' });
  });

  it.each([
    [new ApiError({ status: 409, code: 'ORDER_VERSION_CONFLICT', message: 'conflict' }), 'version-conflict'],
    [new ApiError({ status: 403, code: 'PERMISSION_DENIED', message: 'denied' }), 'permission-denied'],
    [new ApiError({ status: 422, code: 'VALIDATION_ERROR', message: 'gone' }), 'status-unavailable'],
    [new TypeError('transport lost'), 'ambiguous'],
  ])('classifies command failure %s', (error, expected) => {
    expect(classifyOrderStatusBoardMoveFailure(error)).toBe(expected);
  });

  it('restores keyboard focus to moved card, trigger fallback, then heading', () => {
    const cardFocus = vi.fn();
    const triggerFocus = vi.fn();
    const titleFocus = vi.fn();

    expect(
      restoreOrderStatusBoardFocus(
        10,
        { focus: triggerFocus, isConnected: true },
        () => ({ focus: cardFocus }),
        () => ({ focus: titleFocus }),
      ),
    ).toBe('card');
    expect(cardFocus).toHaveBeenCalledOnce();

    expect(
      restoreOrderStatusBoardFocus(
        10,
        { focus: triggerFocus, isConnected: true },
        () => null,
        () => ({ focus: titleFocus }),
      ),
    ).toBe('trigger');
    expect(triggerFocus).toHaveBeenCalledOnce();

    expect(
      restoreOrderStatusBoardFocus(
        10,
        { focus: triggerFocus, isConnected: false },
        () => null,
        () => ({ focus: titleFocus }),
      ),
    ).toBe('title');
    expect(titleFocus).toHaveBeenCalledOnce();
  });
});

function card(
  overrides: Partial<OrderStatusBoardCard> = {},
): OrderStatusBoardCard {
  return {
    orderId: 10,
    orderName: '10',
    fullNumber: 'ABC-10',
    clientId: 1,
    clientName: 'Клиент',
    priority: 100,
    plannedCompletionDate: null,
    pastPlannedDate: false,
    orderStatusId: 1,
    orderStatusName: 'Новый',
    productionStatusId: 2,
    productionStatusName: 'Раскрой',
    productionStatusFromDetailsEnabled: false,
    paymentStatusId: null,
    paymentStatusName: null,
    finalAmount: null,
    paidAmount: null,
    debtAmount: null,
    partsCount: 0,
    totalArea: 0,
    managerId: null,
    managerName: null,
    updatedAt: '2026-07-19T00:00:00.000Z',
    version: 3,
    canChangeOrderStatus: true,
    canChangeProductionStatus: true,
    ...overrides,
  };
}
