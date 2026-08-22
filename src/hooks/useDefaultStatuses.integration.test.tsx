import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  featureFlags: { useBackendReferences: true },
  backendRetry: vi.fn(() => Promise.resolve()),
  legacyRefetch: {
    order_statuses: vi.fn(() => Promise.resolve()),
    payment_statuses: vi.fn(() => Promise.resolve()),
    production_statuses: vi.fn(() => Promise.resolve()),
  },
  backend: {
    enabled: true,
    data: null,
    references: {
      defaultOrderStatus: 10,
      defaultPaymentStatus: 20,
      defaultProductionStatus: 30,
    },
    isLoading: false,
    error: null as Error | null,
  },
  legacyError: null as Error | null,
}));

vi.mock('../config/featureFlags', () => ({ featureFlags: mocks.featureFlags }));
vi.mock('./useOrderFormData', () => ({
  useOrderFormData: () => ({
    ...mocks.backend,
    retry: mocks.backendRetry,
  }),
}));
vi.mock('../query/orderLifecycleQueries', () => ({
  useList: ({ resource }: { resource: keyof typeof mocks.legacyRefetch }) => ({
    data: { data: resource === 'order_statuses'
      ? [{ order_status_id: 11, order_status_name: 'Предварительный' }]
      : resource === 'payment_statuses'
        ? [{ payment_status_id: 21 }]
        : [{ production_status_id: 31 }] },
    isLoading: false,
    error: resource === 'order_statuses' ? mocks.legacyError : null,
    refetch: mocks.legacyRefetch[resource],
  }),
}));

import { useDefaultStatuses } from './useDefaultStatuses';

describe('useDefaultStatuses provider retry routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.featureFlags.useBackendReferences = true;
    mocks.backend.enabled = true;
    mocks.backend.error = null;
    mocks.legacyError = null;
  });

  it('routes backend form-data error retry only to shared backend owner', async () => {
    mocks.backend.error = new Error('backend references failed');
    let latest!: ReturnType<typeof useDefaultStatuses>;
    let renderer!: ReactTestRenderer;

    act(() => {
      renderer = create(<Probe publish={(result) => { latest = result; }} />);
    });
    expect(latest.error?.message).toBe('backend references failed');

    await act(async () => {
      await latest.retry();
    });

    expect(mocks.backendRetry).toHaveBeenCalledOnce();
    Object.values(mocks.legacyRefetch).forEach((refetch) => {
      expect(refetch).not.toHaveBeenCalled();
    });
    act(() => renderer.unmount());
  });

  it('surfaces legacy error and retries all three legacy status owners', async () => {
    mocks.featureFlags.useBackendReferences = false;
    mocks.backend.enabled = false;
    mocks.legacyError = new Error('legacy statuses failed');
    let latest!: ReturnType<typeof useDefaultStatuses>;
    let renderer!: ReactTestRenderer;

    act(() => {
      renderer = create(<Probe publish={(result) => { latest = result; }} />);
    });
    expect(latest.error?.message).toBe('legacy statuses failed');

    await act(async () => {
      await latest.retry();
    });

    expect(mocks.backendRetry).not.toHaveBeenCalled();
    Object.values(mocks.legacyRefetch).forEach((refetch) => {
      expect(refetch).toHaveBeenCalledOnce();
    });
    act(() => renderer.unmount());
  });
});

function Probe({
  publish,
}: {
  publish: (result: ReturnType<typeof useDefaultStatuses>) => void;
}) {
  publish(useDefaultStatuses());
  return null;
}
