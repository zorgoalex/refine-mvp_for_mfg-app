import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/apiError';
import type { OrderStatusBoardCard } from '../../api/types/orderStatusBoardApi.types';
import {
  classifyOrderStatusBoardMoveFailure,
  executeOrderStatusBoardMove,
  isCncPreviewRequestCurrent,
  releaseCncPreviewLoadKey,
  reserveOrderStatusBoardMutation,
  revealOrderStatusBoardCard,
  restoreOrderStatusBoardFocus,
  syncCncBathSelectedDetail,
} from './interaction';

describe('order status board interactions', () => {
  it('reserves synchronously and rejects a duplicate/concurrent command', () => {
    const reserved = reserveOrderStatusBoardMutation(new Set(), 10);
    expect(reserved).toEqual(new Set([10]));
    expect(reserveOrderStatusBoardMutation(reserved!, 11)).toBeNull();
  });

  it('moves production auto-mode cards without a confirmation step', async () => {
    const changeOrderStatus = vi.fn();
    const changeProductionStatus = vi.fn().mockResolvedValue({});
    const refetch = vi.fn().mockResolvedValue(true);
    const afterCommand = vi.fn();

    const result = await executeOrderStatusBoardMove(
      {
        board: 'production',
        card: card({ productionStatusFromDetailsEnabled: true }),
        targetStatusId: 7,
        targetName: 'Упаковка',
        idempotencyKey: 'board:test-auto',
      },
      {
        changeOrderStatus,
        changeProductionStatus,
        afterCommand,
        refetch,
      },
    );

    expect(result).toEqual({ kind: 'refreshed' });
    expect(changeOrderStatus).not.toHaveBeenCalled();
    expect(changeProductionStatus).toHaveBeenCalledWith(10, {
      productionStatusId: 7,
      version: 3,
      idempotencyKey: 'board:test-auto',
    });
    expect(afterCommand).toHaveBeenCalledTimes(1);
    expect(refetch).toHaveBeenCalledTimes(1);
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

  it('reveals a touch-moved card by scrolling nested board axes independently', () => {
    const focus = vi.fn();
    const scrollBoard = vi.fn();
    const scrollCards = vi.fn();

    expect(
      revealOrderStatusBoardCard(
        {
          focus,
          getBoundingClientRect: () => ({
            left: 1300,
            top: 1100,
            width: 240,
            height: 100,
          }),
        },
        {
          clientWidth: 800,
          clientHeight: 600,
          scrollWidth: 2400,
          scrollHeight: 600,
          scrollLeft: 100,
          scrollTop: 0,
          scrollTo: scrollBoard,
          getBoundingClientRect: () => ({
            left: 100,
            top: 0,
            width: 800,
            height: 600,
          }),
        },
        {
          clientWidth: 240,
          clientHeight: 600,
          scrollWidth: 240,
          scrollHeight: 1800,
          scrollLeft: 0,
          scrollTop: 200,
          scrollTo: scrollCards,
          getBoundingClientRect: () => ({
            left: 1300,
            top: 100,
            width: 240,
            height: 600,
          }),
        },
        false,
      ),
    ).toBe(true);

    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(scrollBoard).toHaveBeenCalledWith({ left: 1020, behavior: 'smooth' });
    expect(scrollCards).toHaveBeenCalledWith({ top: 950, behavior: 'smooth' });
  });

  it('updates the selected bath detail marker in the rendered SVG without rebuilding it', () => {
    const first = detailMarker(11, true);
    const second = detailMarker(12, false);
    const querySelectorAll = vi.fn().mockReturnValue([first.element, second.element]);
    const root = { querySelectorAll } as unknown as HTMLElement;

    syncCncBathSelectedDetail(root, 12);

    expect(first.removeAttribute).toHaveBeenCalledWith('data-cnc-selected-detail');
    expect(second.setAttribute).toHaveBeenCalledWith('data-cnc-selected-detail', 'true');

    syncCncBathSelectedDetail(root, null);

    expect(second.removeAttribute).toHaveBeenCalledWith('data-cnc-selected-detail');
    expect(querySelectorAll).toHaveBeenCalledTimes(2);
  });

  it('releases only an unfinished matching preview load so collapse reopen can retry', () => {
    expect(releaseCncPreviewLoadKey('bath:1', 'bath:1', false)).toBeNull();
    expect(releaseCncPreviewLoadKey('bath:1', 'bath:1', true)).toBe('bath:1');
    expect(releaseCncPreviewLoadKey('bath:2', 'bath:1', false)).toBe('bath:2');
  });

  it('prevents a cancelled or stale PDF request from settling a newer same-key request', () => {
    expect(isCncPreviewRequestCurrent(false, 2, 2)).toBe(true);
    expect(isCncPreviewRequestCurrent(true, 2, 2)).toBe(false);
    expect(isCncPreviewRequestCurrent(false, 3, 2)).toBe(false);
  });
});

function detailMarker(detailId: number, selected: boolean) {
  const attributes = new Map<string, string>([
    ['data-detail-id', String(detailId)],
    ...(selected ? [['data-cnc-selected-detail', 'true'] as [string, string]] : []),
  ]);
  const setAttribute = vi.fn((name: string, value: string) => attributes.set(name, value));
  const removeAttribute = vi.fn((name: string) => attributes.delete(name));
  return {
    element: {
      getAttribute: (name: string) => attributes.get(name) ?? null,
      setAttribute,
      removeAttribute,
    } as unknown as SVGElement,
    setAttribute,
    removeAttribute,
  };
}

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
    orderStatusIssuedOrLater: false,
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
    details: [],
    managerId: null,
    managerName: null,
    updatedAt: '2026-07-19T00:00:00.000Z',
    version: 3,
    canChangeOrderStatus: true,
    canChangeProductionStatus: true,
    ...overrides,
  };
}
