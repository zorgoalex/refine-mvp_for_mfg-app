import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  formatProductionActionPermissionDeniedMessage,
  isProductionActionPermissionDenied,
  isProductionActionVersionConflict,
  productionActionsApi,
  validateOrderDetailId,
  validateProductionStatusId,
} from './productionActionsApi';
import { ApiError } from './apiError';

describe('productionActionsApi', () => {
  beforeEach(() => {
    vi.stubEnv('VITE_API_URL', '');
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('routes calendar date, order status, payment status, production current status, and production stage commands to backend endpoints', async () => {
    const fetchMock = mockFetch(
      responseBody({ plannedCompletionDate: '2026-05-20' }),
      responseBody({ orderStatusId: 5 }),
      responseBody({ paymentStatusId: 3 }),
      responseBody({ productionStatusId: 2 }),
      responseBody({ event: { productionEventId: 10, productionStatusId: 4, active: true } }),
      responseBody({ event: { productionEventId: 10, productionStatusId: 4, active: false } }),
      responseBody({ event: { productionEventId: 11, productionStatusId: 4, active: true } }),
    );

    await productionActionsApi.moveCalendarDate(15, {
      plannedCompletionDate: '2026-05-20',
      version: 3,
      idempotencyKey: 'move-key-1',
    });
    await productionActionsApi.changeOrderStatus(15, {
      orderStatusId: 5,
      version: 4,
      idempotencyKey: 'status-key-1',
    });
    await productionActionsApi.changePaymentStatus(15, {
      paymentStatusId: 3,
      version: 5,
      idempotencyKey: 'payment-status-key-1',
    });
    await productionActionsApi.changeProductionStatus(15, {
      productionStatusId: 2,
      version: 6,
      idempotencyKey: 'production-status-key-1',
    });
    await productionActionsApi.activateProductionStage(15, 4, {
      version: 7,
      idempotencyKey: 'stage-on-key-1',
    });
    await productionActionsApi.deactivateProductionStage(15, 4, {
      version: 8,
      idempotencyKey: 'stage-off-key-1',
    });
    await productionActionsApi.activateDetailProductionStage(99, 4, {
      idempotencyKey: 'detail-stage-key-1',
      note: 'started cutting',
    });

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/orders/15/calendar-date');
    expect(fetchMock.mock.calls[0][1]?.method).toBe('PATCH');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/orders/15/status');
    expect(fetchMock.mock.calls[1][1]?.method).toBe('PATCH');
    expect(fetchMock.mock.calls[2][0]).toBe('/api/v1/orders/15/payment-status');
    expect(fetchMock.mock.calls[2][1]?.method).toBe('PATCH');
    expect(fetchMock.mock.calls[3][0]).toBe('/api/v1/orders/15/production-status');
    expect(fetchMock.mock.calls[3][1]?.method).toBe('PATCH');
    expect(fetchMock.mock.calls[3][1]?.body).toBe(
      JSON.stringify({ productionStatusId: 2, version: 6, idempotencyKey: 'production-status-key-1' }),
    );
    expect(fetchMock.mock.calls[4][0]).toBe('/api/v1/orders/15/production-stage-events/4');
    expect(fetchMock.mock.calls[4][1]?.method).toBe('PUT');
    expect(fetchMock.mock.calls[5][0]).toBe('/api/v1/orders/15/production-stage-events/4');
    expect(fetchMock.mock.calls[5][1]?.method).toBe('DELETE');
    expect(fetchMock.mock.calls[5][1]?.body).toBe(
      JSON.stringify({ version: 8, idempotencyKey: 'stage-off-key-1' }),
    );
    expect(fetchMock.mock.calls[6][0]).toBe('/api/v1/order-details/99/production-stage-events/4');
    expect(fetchMock.mock.calls[6][1]?.method).toBe('PUT');
    expect(fetchMock.mock.calls[6][1]?.body).toBe(
      JSON.stringify({ idempotencyKey: 'detail-stage-key-1', note: 'started cutting' }),
    );
  });

  it('rejects invalid production detail and status ids before fetch', async () => {
    const fetchMock = mockFetch(responseBody());

    expect(() => validateOrderDetailId(0)).toThrow('Invalid detailId');
    expect(() => validateProductionStatusId(0)).toThrow('Invalid productionStatusId');
    expect(() =>
      productionActionsApi.activateProductionStage(15, 1.5, {
        version: 1,
        idempotencyKey: 'stage-key-1',
      }),
    ).toThrow('Invalid productionStatusId');
    expect(() =>
      productionActionsApi.activateDetailProductionStage(1.5, 4, {
        idempotencyKey: 'detail-stage-key-1',
      }),
    ).toThrow('Invalid detailId');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('detects backend production action version conflicts', () => {
    expect(
      isProductionActionVersionConflict(
        new ApiError({
          code: 'VERSION_CONFLICT',
          message: 'Order version conflict',
          status: 409,
        }),
      ),
    ).toBe(true);
    expect(
      isProductionActionVersionConflict(
        new ApiError({
          code: 'ORDER_VERSION_CONFLICT',
          message: 'Order version conflict',
          status: 409,
        }),
      ),
    ).toBe(true);
    expect(isProductionActionVersionConflict(new Error('nope'))).toBe(false);
  });

  it('formats permission denied production action messages for users', () => {
    const error = new ApiError({
      code: 'PERMISSION_DENIED',
      message: 'Недостаточно прав для выполнения действия',
      status: 403,
    });

    expect(isProductionActionPermissionDenied(error)).toBe(true);
    expect(formatProductionActionPermissionDeniedMessage('order_status')).toBe(
      'Вы не имеете права менять статус на чужом заказе.',
    );
    expect(formatProductionActionPermissionDeniedMessage('payment_status')).toBe(
      'Вы не имеете права менять статус оплаты на чужом заказе.',
    );
    expect(formatProductionActionPermissionDeniedMessage('production_stage')).toBe(
      'Вы не имеете права менять этап производства на чужом заказе.',
    );
  });
});

function mockFetch(...bodies: unknown[]) {
  const fetchMock = vi.fn();
  for (const body of bodies) {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
  }
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function responseBody(overrides: Record<string, unknown> = {}) {
  return {
    order: {
      orderId: 15,
      version: 4,
      ...overrides,
    },
    requestId: 'request-1',
  };
}
