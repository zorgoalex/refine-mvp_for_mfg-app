import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authSession } from '../api/authSession';
import type { OrderFormDataResponse } from '../api/types/orderApi.types';

const ordersApiMock = vi.hoisted(() => ({
  getFormData: vi.fn(),
}));

vi.mock('../api/ordersApi', () => ({ ordersApi: ordersApiMock }));

import {
  getCurrentOrderFormDataNamespace,
  getOrderFormDataResourceDiagnostics,
  getOrderFormDataResourceSnapshot,
  invalidateOrderFormDataCache,
  prefetchOrderFormData,
  resetOrderFormDataCacheForTests,
  subscribeOrderFormDataResource,
} from './orderFormDataCache';

describe('auth-scoped order form-data resource', () => {
  beforeEach(() => {
    authSession.clear();
    resetOrderFormDataCacheForTests();
    ordersApiMock.getFormData.mockReset();
  });

  afterEach(() => {
    authSession.clear();
    resetOrderFormDataCacheForTests();
  });

  it('shares one request and one normalization across twenty consumers', async () => {
    ordersApiMock.getFormData.mockResolvedValue(response('Shared film'));
    const namespace = getCurrentOrderFormDataNamespace();
    const unsubscribers = Array.from(
      { length: 20 },
      () => subscribeOrderFormDataResource(() => undefined),
    );

    const requests = Array.from({ length: 20 }, () => prefetchOrderFormData(namespace));

    expect(new Set(requests).size).toBe(1);
    await Promise.all(requests);
    const snapshots = Array.from(
      { length: 20 },
      () => getOrderFormDataResourceSnapshot(namespace),
    );

    expect(ordersApiMock.getFormData).toHaveBeenCalledTimes(1);
    expect(getOrderFormDataResourceDiagnostics()).toMatchObject({
      requestCount: 1,
      normalizationCount: 1,
      referenceOwnerCount: 1,
      subscriberCount: 20,
    });
    expect(new Set(snapshots.map((snapshot) => snapshot.normalizedReferences)).size).toBe(1);
    expect(snapshots[0]?.normalizedReferences.films[0]?.label).toBe('Shared film');
    expect(snapshots[0]?.revision).toBe(1);
    expect(snapshots[0]?.status).toBe('ready');
    unsubscribers.forEach((unsubscribe) => unsubscribe());
  });

  it('aborts and removes actor A namespace before actor B can publish', async () => {
    let resolveActorA!: (value: OrderFormDataResponse) => void;
    let resolveActorB!: (value: OrderFormDataResponse) => void;
    let actorASignal: AbortSignal | undefined;
    ordersApiMock.getFormData
      .mockImplementationOnce((opts?: { signal?: AbortSignal }) => {
        actorASignal = opts?.signal;
        return new Promise<OrderFormDataResponse>((resolve) => {
          resolveActorA = resolve;
        });
      })
      .mockImplementationOnce(() => new Promise<OrderFormDataResponse>((resolve) => {
        resolveActorB = resolve;
      }));

    authSession.setAccessToken('actor-a-token');
    authSession.setUser({
      id: 'actor-a',
      username: 'actor-a',
      role: 'admin',
      permissions: ['orders.view'],
    });
    const actorANamespace = getCurrentOrderFormDataNamespace();
    const actorARequest = prefetchOrderFormData(actorANamespace);

    authSession.clear();
    expect(actorASignal?.aborted).toBe(true);
    authSession.setAccessToken('actor-b-token');
    authSession.setUser({
      id: 'actor-b',
      username: 'actor-b',
      role: 'admin',
      permissions: ['orders.view', 'references.view'],
    });
    const actorBNamespace = getCurrentOrderFormDataNamespace();
    expect(actorBNamespace).not.toBe(actorANamespace);
    const actorBRequest = prefetchOrderFormData(actorBNamespace);

    resolveActorB(response('Actor B film'));
    await actorBRequest;
    resolveActorA(response('Actor A film'));
    await actorARequest;

    expect(getOrderFormDataResourceSnapshot(actorBNamespace).normalizedReferences.films)
      .toEqual([expect.objectContaining({ label: 'Actor B film' })]);
    expect(getOrderFormDataResourceSnapshot(actorANamespace).data).toBeNull();
  });

  it('keeps last-good data and references after a background error', async () => {
    const namespace = getCurrentOrderFormDataNamespace();
    ordersApiMock.getFormData
      .mockResolvedValueOnce(response('Last good film'))
      .mockRejectedValueOnce(new Error('temporary failure'));

    await prefetchOrderFormData(namespace);
    const ready = getOrderFormDataResourceSnapshot(namespace);
    invalidateOrderFormDataCache(namespace);
    await expect(prefetchOrderFormData(namespace)).rejects.toThrow('temporary failure');
    const failed = getOrderFormDataResourceSnapshot(namespace);

    expect(failed.data).toBe(ready.data);
    expect(failed.normalizedReferences).toBe(ready.normalizedReferences);
    expect(failed.normalizedReferences.films[0]?.label).toBe('Last good film');
    expect(failed.status).toBe('error');
    expect(failed.error?.message).toBe('temporary failure');
    expect(failed.inFlight).toBe(false);
  });

  it('uses actor, session, scope and backend mode in the namespace', () => {
    authSession.setAccessToken('actor-token');
    authSession.setUser({
      id: 'actor-1',
      username: 'actor-1',
      role: 'admin',
      permissions: ['orders.view'],
      permissionsVersion: 7,
    });

    const namespace = getCurrentOrderFormDataNamespace();

    expect(namespace).toContain('actor:actor-1');
    expect(namespace).toMatch(/session:\d+/);
    expect(namespace).toMatch(/scope:[a-f0-9]{8}/);
    expect(namespace).toContain('mode:backend-order-form-data');
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
