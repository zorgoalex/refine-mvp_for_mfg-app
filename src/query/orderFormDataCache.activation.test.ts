import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrderFormDataResponse } from '../api/types/orderApi.types';

const ordersApiMock = vi.hoisted(() => ({
  getFormData: vi.fn(),
}));

vi.mock('../api/ordersApi', () => ({ ordersApi: ordersApiMock }));

import {
  getOrderFormDataCacheGeneration,
  isOrderFormDataCacheStale,
  ORDER_FORM_DATA_STALE_TIME_MS,
  prefetchOrderFormData,
  prepareOrderFormDataActivationRefresh,
  resetOrderFormDataCacheForTests,
} from './orderFormDataCache';

describe('orderFormDataCache activation refresh', () => {
  let now = 1_000_000;

  beforeEach(() => {
    now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    ordersApiMock.getFormData.mockReset();
    resetOrderFormDataCacheForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('clears a settled promise so a TTL-stale remount performs a new read', async () => {
    ordersApiMock.getFormData
      .mockResolvedValueOnce(response('first'))
      .mockResolvedValueOnce(response('second'));

    await prefetchOrderFormData();
    now += ORDER_FORM_DATA_STALE_TIME_MS + 1;

    expect(isOrderFormDataCacheStale()).toBe(true);
    await prefetchOrderFormData();

    expect(ordersApiMock.getFormData).toHaveBeenCalledTimes(2);
  });

  it('lets twenty consumers share one stale activation decision and request', async () => {
    ordersApiMock.getFormData
      .mockResolvedValueOnce(response('first'))
      .mockResolvedValueOnce(response('second'));
    await prefetchOrderFormData();
    now += ORDER_FORM_DATA_STALE_TIME_MS + 1;
    const generationBeforeActivation = getOrderFormDataCacheGeneration();

    const decisions = Array.from(
      { length: 20 },
      () => prepareOrderFormDataActivationRefresh(7),
    );

    expect(decisions.every((decision) => decision.refreshRequired)).toBe(true);
    expect(decisions.filter((decision) => decision.ownsRefresh)).toHaveLength(1);
    expect(getOrderFormDataCacheGeneration()).toBe(generationBeforeActivation + 1);

    const requests = Array.from({ length: 20 }, () => prefetchOrderFormData());
    expect(new Set(requests).size).toBe(1);
    await Promise.all(requests);
    expect(ordersApiMock.getFormData).toHaveBeenCalledTimes(2);

    expect(prepareOrderFormDataActivationRefresh(8)).toEqual({
      refreshRequired: false,
      ownsRefresh: false,
    });
  });

  it('marks an initial request failure stale so activation can retry it', async () => {
    ordersApiMock.getFormData.mockRejectedValueOnce(new Error('temporary failure'));

    await expect(prefetchOrderFormData()).rejects.toThrow('temporary failure');

    expect(isOrderFormDataCacheStale()).toBe(true);
    expect(prepareOrderFormDataActivationRefresh(9)).toEqual({
      refreshRequired: true,
      ownsRefresh: true,
    });
  });
});

function response(name: string): OrderFormDataResponse {
  return {
    clients: [],
    orderStatuses: [],
    paymentStatuses: [],
    productionStatuses: [],
    materials: [],
    millingTypes: [],
    edgeTypes: [],
    films: [{ id: 1, name, sortOrder: 1 }],
    workshops: [],
    paymentTypes: [],
    employees: [],
    units: [],
  };
}
