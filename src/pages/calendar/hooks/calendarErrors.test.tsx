import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { HttpError } from '@refinedev/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCalendarData } from './useCalendarData';
import { useOrderStatuses } from './useOrderStatuses';

type QueryState = {
  data?: { data: Record<string, unknown>[] };
  isLoading?: boolean;
  isError?: boolean;
  error?: HttpError | Error | null;
};

const mocks = vi.hoisted(() => ({
  queries: {} as Record<string, QueryState>,
  refetch: vi.fn(),
  useList: vi.fn(),
}));

vi.mock('@refinedev/core', () => ({ useList: mocks.useList }));
vi.mock('../../../hooks/useAppSettings', () => ({
  useAppSettings: () => ({ getSetting: () => undefined }),
  SETTING_KEYS: { PRODUCTION_WORKFLOW_DEFAULT: 'production_workflow_default' },
}));

function readHook<T>(hook: () => T): T {
  let result!: T;
  function Probe() {
    result = hook();
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return result;
}

const httpError = (message: string): HttpError => Object.freeze({ message, statusCode: 503 });
const readCalendar = () => readHook(() => useCalendarData(new Date(2026, 8, 1), new Date(2026, 8, 7)));
const readStatuses = (options?: Parameters<typeof useOrderStatuses>[0]) => readHook(() => useOrderStatuses(options));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.queries = {};
  mocks.useList.mockImplementation(({ resource }: { resource: string }) => ({
    data: { data: [] }, isLoading: false, isError: false, error: null,
    refetch: mocks.refetch,
    ...mocks.queries[resource],
  }));
});

describe('useCalendarData error capability', () => {
  it.each([
    ['plain HttpError without name', httpError('Тест: календарь недоступен')],
    ['native Error', new Error('Тест: сеть недоступна')],
    ['empty message', httpError('')],
  ])('preserves %s object and message', (_label, error) => {
    mocks.queries.orders_view = { isError: true, error };
    const result = readCalendar();
    expect(result.error).toBe(error);
    expect(result.error?.message).toBe(error.message);
    expect(result.refetch).toBe(mocks.refetch);
    expect(result.ordersByDate).toEqual({});
  });

  it('exposes no error when the main query is healthy, even with a stale error object', () => {
    mocks.queries.orders_view = { isError: false, error: httpError('Тест: старая ошибка') };
    expect(readCalendar().error).toBeUndefined();
  });

  it('retains the existing boundary: supplementary lookup errors are not the main error', () => {
    mocks.queries.production_statuses = { isError: true, error: httpError('Тест: справочник') };
    expect(readCalendar().error).toBeUndefined();
  });

  it('keeps loading and retry behavior independent of the error shape', () => {
    mocks.queries.orders_view = { isLoading: true };
    const result = readCalendar();
    expect(result.isLoading).toBe(true);
    expect(result.error).toBeUndefined();
    result.refetch();
    expect(mocks.refetch).toHaveBeenCalledOnce();
  });
});

describe('useOrderStatuses error capability', () => {
  for (const resource of ['order_statuses', 'payment_statuses', 'production_statuses']) {
    it.each([
      ['plain HttpError without name', httpError(`Тест: ${resource}`)],
      ['native Error', new Error(`Тест: ${resource}`)],
    ])(`preserves ${resource} %s without wrapping or dropping metadata`, (_label, error) => {
      mocks.queries[resource] = { isError: true, error };
      const result = readStatuses();
      expect(result.error).toBe(error);
      expect(result.error?.message).toBe(error.message);
    });
  }

  it.each([
    [true, true, true, 'order_statuses'],
    [false, true, true, 'payment_statuses'],
    [false, false, true, 'production_statuses'],
  ])('preserves priority for error flags %s/%s/%s', (order, payment, production, expected) => {
    for (const [resource, isError] of [['order_statuses', order], ['payment_statuses', payment], ['production_statuses', production]] as const) {
      mocks.queries[resource] = { isError, error: httpError(`Тест: ${resource}`) };
    }
    expect(readStatuses().error).toBe(mocks.queries[expected].error);
  });

  it('ignores stale error objects when no query reports an error', () => {
    for (const resource of ['order_statuses', 'payment_statuses', 'production_statuses']) {
      mocks.queries[resource] = { error: httpError('Тест: старая ошибка'), isError: false };
    }
    expect(readStatuses().error).toBeUndefined();
  });

  it('ignores payment error/loading when payment loading is disabled, while retaining production errors', () => {
    const paymentError = httpError('Тест: оплата');
    mocks.queries.payment_statuses = { isError: true, isLoading: true, error: paymentError };
    expect(readStatuses({ loadPayment: false })).toMatchObject({ error: undefined, isLoading: false });
    const productionError = httpError('Тест: производство');
    mocks.queries.production_statuses = { isError: true, error: productionError };
    expect(readStatuses({ loadPayment: false }).error).toBe(productionError);
    expect(mocks.useList).toHaveBeenCalledWith(expect.objectContaining({
      resource: 'payment_statuses', queryOptions: { enabled: false },
    }));
  });

  it('ignores both disabled lookups but never hides an order-status error', () => {
    for (const resource of ['payment_statuses', 'production_statuses']) {
      mocks.queries[resource] = { isLoading: true, isError: true, error: httpError(`Тест: ${resource}`) };
    }
    const options = { loadPaymentAndProduction: false, loadPayment: true };
    expect(readStatuses(options)).toMatchObject({ error: undefined, isLoading: false });
    const orderError = httpError('Тест: заказ');
    mocks.queries.order_statuses = { isError: true, error: orderError };
    expect(readStatuses(options).error).toBe(orderError);
    for (const resource of ['payment_statuses', 'production_statuses']) {
      expect(mocks.useList).toHaveBeenCalledWith(expect.objectContaining({ resource, queryOptions: { enabled: false } }));
    }
  });

  it('retains mapped reference values and active-query loading', () => {
    mocks.queries.order_statuses = { data: { data: [{ order_status_id: 1, order_status_name: 'Тест заказ' }] } };
    mocks.queries.payment_statuses = { data: { data: [{ payment_status_id: 2, payment_status_name: 'Тест оплата' }] }, isLoading: true };
    mocks.queries.production_statuses = { data: { data: [{ production_status_id: 3, production_status_name: 'Тест производство' }] } };
    expect(readStatuses()).toEqual({
      orderStatuses: [{ id: 1, name: 'Тест заказ' }], paymentStatuses: [{ id: 2, name: 'Тест оплата' }],
      productionStatuses: [{ id: 3, name: 'Тест производство' }], isLoading: true, error: undefined,
    });
  });
});
