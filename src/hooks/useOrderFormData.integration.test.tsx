import React, { StrictMode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authSession } from '../api/authSession';
import type { OrderFormDataResponse } from '../api/types/orderApi.types';
import type { OrderFormDataReferences } from '../query/orderFormDataReferences';

const ordersApiMock = vi.hoisted(() => ({
  getFormData: vi.fn(),
}));
const referenceEventsHarness = vi.hoisted(() => {
  let listener: (() => void) | null = null;
  return {
    subscribe: vi.fn((nextListener: () => void) => {
      listener = nextListener;
      return () => {
        if (listener === nextListener) listener = null;
      };
    }),
    emit() {
      listener?.();
    },
    reset() {
      listener = null;
      this.subscribe.mockClear();
    },
  };
});

vi.mock('../api/ordersApi', () => ({ ordersApi: ordersApiMock }));
vi.mock('../api/orderFormReferenceEvents', () => ({
  subscribeOrderFormReferencesChanged: referenceEventsHarness.subscribe,
}));
vi.mock('../query/orderLifecycleQueries', () => ({
  useOrderLifecycleReadActive: () => true,
}));
vi.mock('../performance/appActivityCoordinator', () => ({
  useAppActivitySnapshot: () => ({
    activationRevision: 0,
    documentVisible: true,
    windowFocused: true,
  }),
  recordAppActivityRefreshTrigger: vi.fn(),
}));

import { useOrderFormData } from './useOrderFormData';
import {
  getOrderFormDataResourceDiagnostics,
  resetOrderFormDataCacheForTests,
} from '../query/orderFormDataCache';

describe('useOrderFormData shared owner integration', () => {
  beforeEach(() => {
    authSession.clear();
    resetOrderFormDataCacheForTests();
    ordersApiMock.getFormData.mockReset();
    referenceEventsHarness.reset();
    authSession.setAccessToken('actor-token');
    authSession.setUser({
      id: 'actor-1',
      username: 'actor-1',
      role: 'admin',
      permissions: ['orders.view', 'references.view'],
    });
  });

  afterEach(() => {
    authSession.clear();
    resetOrderFormDataCacheForTests();
  });

  it('serves twenty mounted hook consumers with one request and one mapper result', async () => {
    ordersApiMock.getFormData.mockResolvedValue(response('Shared hook film'));
    const latestReferences = new Map<number, OrderFormDataReferences>();
    let renderer: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        <StrictMode>
          {Array.from({ length: 20 }, (_, index) => (
            <Consumer key={index} index={index} latest={latestReferences} />
          ))}
        </StrictMode>,
      );
      await flushPromises();
    });
    await act(async () => {
      await flushPromises();
    });

    expect(ordersApiMock.getFormData).toHaveBeenCalledTimes(1);
    expect(getOrderFormDataResourceDiagnostics()).toMatchObject({
      requestCount: 1,
      normalizationCount: 1,
      referenceOwnerCount: 1,
      subscriberCount: 20,
    });
    expect(referenceEventsHarness.subscribe).toHaveBeenCalledTimes(1);
    expect(latestReferences.size).toBe(20);
    expect(new Set(latestReferences.values()).size).toBe(1);
    expect(latestReferences.get(0)?.films[0]?.label).toBe('Shared hook film');

    await act(async () => {
      renderer!.unmount();
    });
    expect(getOrderFormDataResourceDiagnostics().subscriberCount).toBe(0);
  });

  it('keeps twenty disabled StrictMode consumers outside the backend resource', async () => {
    const renderCounts = new Map<number, number>();
    let renderer: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        <StrictMode>
          {Array.from({ length: 20 }, (_, index) => (
            <DisabledConsumer key={index} index={index} renders={renderCounts} />
          ))}
        </StrictMode>,
      );
      await flushPromises();
    });
    const rendersBeforeReferenceEvent = sum(renderCounts.values());

    await act(async () => {
      referenceEventsHarness.emit();
      await flushPromises();
    });

    expect(ordersApiMock.getFormData).not.toHaveBeenCalled();
    expect(referenceEventsHarness.subscribe).not.toHaveBeenCalled();
    expect(getOrderFormDataResourceDiagnostics()).toMatchObject({
      requestCount: 0,
      normalizationCount: 0,
      referenceOwnerCount: 0,
      subscriberCount: 0,
    });
    expect(sum(renderCounts.values())).toBe(rendersBeforeReferenceEvent);

    await act(async () => {
      renderer!.unmount();
    });
  });
});

function Consumer({
  index,
  latest,
}: {
  index: number;
  latest: Map<number, OrderFormDataReferences>;
}) {
  const result = useOrderFormData(true);
  latest.set(index, result.references);
  return null;
}

function DisabledConsumer({
  index,
  renders,
}: {
  index: number;
  renders: Map<number, number>;
}) {
  useOrderFormData(false);
  renders.set(index, (renders.get(index) ?? 0) + 1);
  return null;
}

function sum(values: Iterable<number>): number {
  return Array.from(values).reduce((total, value) => total + value, 0);
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

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
