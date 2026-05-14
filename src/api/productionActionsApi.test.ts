import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isProductionActionVersionConflict,
  productionActionsApi,
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

  it('routes calendar date, order status, and production stage commands to backend endpoints', async () => {
    const fetchMock = mockFetch(
      responseBody({ plannedCompletionDate: '2026-05-20' }),
      responseBody({ orderStatusId: 5 }),
      responseBody({ event: { productionEventId: 10, productionStatusId: 4, active: true } }),
      responseBody({ event: { productionEventId: 10, productionStatusId: 4, active: false } }),
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
    await productionActionsApi.activateProductionStage(15, 4, {
      version: 5,
      idempotencyKey: 'stage-on-key-1',
    });
    await productionActionsApi.deactivateProductionStage(15, 4, {
      version: 6,
      idempotencyKey: 'stage-off-key-1',
    });

    expect(fetchMock.mock.calls[0][0]).toBe('/api/v1/orders/15/calendar-date');
    expect(fetchMock.mock.calls[0][1]?.method).toBe('PATCH');
    expect(fetchMock.mock.calls[1][0]).toBe('/api/v1/orders/15/status');
    expect(fetchMock.mock.calls[1][1]?.method).toBe('PATCH');
    expect(fetchMock.mock.calls[2][0]).toBe('/api/v1/orders/15/production-stage-events/4');
    expect(fetchMock.mock.calls[2][1]?.method).toBe('PUT');
    expect(fetchMock.mock.calls[3][0]).toBe('/api/v1/orders/15/production-stage-events/4');
    expect(fetchMock.mock.calls[3][1]?.method).toBe('DELETE');
    expect(fetchMock.mock.calls[3][1]?.body).toBe(
      JSON.stringify({ version: 6, idempotencyKey: 'stage-off-key-1' }),
    );
  });

  it('rejects invalid production status ids before fetch', async () => {
    const fetchMock = mockFetch(responseBody());

    expect(() => validateProductionStatusId(0)).toThrow('Invalid productionStatusId');
    expect(() =>
      productionActionsApi.activateProductionStage(15, 1.5, {
        version: 1,
        idempotencyKey: 'stage-key-1',
      }),
    ).toThrow('Invalid productionStatusId');
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
