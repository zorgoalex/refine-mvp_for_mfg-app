import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authSession } from '../api/authSession';
import type { UserIdentity } from '../types/auth';
import {
  clearWorkspaceOperationPins,
  WorkspaceOperationOwnershipLostError,
} from '../workspace/workspaceOperationPins';

const mocks = vi.hoisted(() => ({
  activateProductionStage: vi.fn(),
  invalidate: vi.fn(() => Promise.resolve()),
  messageWarning: vi.fn(),
  onResponse: vi.fn(),
  refetch: vi.fn(),
}));

vi.mock('@refinedev/core', () => ({
  useDataProvider: () => () => ({
    create: vi.fn(),
    deleteOne: vi.fn(),
  }),
  useInvalidate: () => mocks.invalidate,
}));

vi.mock('antd', () => ({
  message: { warning: mocks.messageWarning },
}));

vi.mock('../components/workspace/KeepAliveContext', () => ({
  useKeepAlive: () => ({ tabKey: '/orders/edit/42' }),
}));

vi.mock('../config/featureFlags', () => ({
  featureFlags: { useBackendProductionActions: true },
}));

vi.mock('../query/orderLifecycleQueries', () => ({
  useList: () => ({
    data: { data: [] },
    isLoading: false,
    refetch: mocks.refetch,
  }),
}));

vi.mock('../api/productionActionsApi', () => ({
  createProductionActionIdempotencyKey: () => 'test-idempotency-key',
  isProductionActionVersionConflict: () => false,
  productionActionsApi: {
    activateProductionStage: mocks.activateProductionStage,
    activateDetailProductionStage: vi.fn(),
    deactivateProductionStage: vi.fn(),
  },
}));

import { useProductionStatusEvent } from './useProductionStatusEvent';

const actor = (permissions: string[]): UserIdentity => ({
  id: '1',
  username: 'actor-1',
  role: 'manager',
  permissions,
});

let recordOrderEvent: ReturnType<typeof useProductionStatusEvent>['recordOrderEvent'];

function Harness() {
  recordOrderEvent = useProductionStatusEvent({ orderId: 42 }).recordOrderEvent;
  return null;
}

describe('production status auth ownership', () => {
  let renderer: ReactTestRenderer;

  beforeEach(() => {
    clearWorkspaceOperationPins();
    authSession.clear();
    authSession.setUser(actor(['orders.update']));
    vi.clearAllMocks();
    act(() => {
      renderer = create(<Harness />);
    });
  });

  it('does not publish response or start invalidation after scope revoke', async () => {
    let resolveAction!: (value: unknown) => void;
    mocks.activateProductionStage.mockReturnValueOnce(new Promise((resolve) => {
      resolveAction = resolve;
    }));
    const operation = recordOrderEvent(42, 7, undefined, {
      version: 3,
      onResponse: mocks.onResponse,
    });
    await vi.waitFor(() => expect(mocks.activateProductionStage).toHaveBeenCalledOnce());

    authSession.setUser(actor(['orders.view']));
    let caught: unknown;
    await act(async () => {
      resolveAction({
        event: { productionEventId: 10 },
        order: { version: 4 },
      });
      try {
        await operation;
      } catch (error) {
        caught = error;
      }
    });

    expect(caught).toBeInstanceOf(WorkspaceOperationOwnershipLostError);
    expect(mocks.onResponse).not.toHaveBeenCalled();
    expect(mocks.invalidate).not.toHaveBeenCalled();
    expect(mocks.messageWarning).not.toHaveBeenCalled();
    renderer.unmount();
  });
});
