import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authSession } from '../api/authSession';
import type { UserIdentity } from '../types/auth';
import type { OrderFormValues } from '../types/orders';
import { ApiError } from '../api/apiError';
import {
  clearWorkspaceOperationPins,
  hasWorkspaceOperationPins,
  runPageOwnedWorkspaceOperation,
  WorkspaceOperationOwnershipLostError,
} from '../workspace/workspaceOperationPins';

const mocks = vi.hoisted(() => ({
  bazisCreateOrderFromDraft: vi.fn(),
  exportOrderToGoogleDrive: vi.fn(),
  invalidate: vi.fn(() => Promise.resolve()),
  messageError: vi.fn(),
  messageSuccess: vi.fn(),
  modalConfirm: vi.fn(),
  notificationDestroy: vi.fn(),
  notificationError: vi.fn(),
  notificationSuccess: vi.fn(),
  saveOrderViaBackend: vi.fn(),
}));

vi.mock('@refinedev/core', () => ({
  useDataProvider: () => () => ({}),
  useInvalidate: () => mocks.invalidate,
}));

vi.mock('antd', () => ({
  message: {
    error: mocks.messageError,
    success: mocks.messageSuccess,
  },
  Modal: {
    confirm: mocks.modalConfirm,
    error: vi.fn(),
    warning: vi.fn(),
  },
  notification: {
    destroy: mocks.notificationDestroy,
    error: mocks.notificationError,
    success: mocks.notificationSuccess,
  },
}));

vi.mock('../config/featureFlags', () => ({
  featureFlags: {
    useBackendOrderExport: true,
    useBackendOrdersWrite: true,
  },
}));

vi.mock('../api/exportApi', () => ({
  exportApi: {
    exportOrderToGoogleDrive: mocks.exportOrderToGoogleDrive,
  },
}));

vi.mock('../api/bazisApi', () => ({
  bazisApi: {
    createOrderFromDraft: mocks.bazisCreateOrderFromDraft,
  },
}));

vi.mock('./useOrderSaveBackend', () => ({
  saveOrderViaBackend: mocks.saveOrderViaBackend,
}));

import { useOrderExport } from './useOrderExport';
import { useOrderSave } from './useOrderSave';

const actor = (id: number, permissions = ['orders.update']): UserIdentity => ({
  id: String(id),
  username: `actor-${id}`,
  role: 'manager',
  permissions,
});

let currentHooks: {
  exportToDrive: ReturnType<typeof useOrderExport>['exportToDrive'];
  saveOrder: ReturnType<typeof useOrderSave>['saveOrder'];
};

function Harness() {
  const workspaceOwnerMountedRef = React.useRef(true);
  React.useEffect(() => () => {
    workspaceOwnerMountedRef.current = false;
  }, []);
  const orderExport = useOrderExport();
  const orderSave = useOrderSave('42', {
    workspaceKey: '/orders/edit/42',
    isWorkspaceOwnerCurrent: () => workspaceOwnerMountedRef.current,
  });
  currentHooks = {
    exportToDrive: orderExport.exportToDrive,
    saveOrder: orderSave.saveOrder,
  };
  return null;
}

function BazisHarness() {
  const workspaceOwnerMountedRef = React.useRef(true);
  React.useEffect(() => () => {
    workspaceOwnerMountedRef.current = false;
  }, []);
  const orderSave = useOrderSave('new', {
    workspaceKey: '/orders/create',
    isWorkspaceOwnerCurrent: () => workspaceOwnerMountedRef.current,
    getBazisDraftSaveContext: () => ({
      revisionId: 7,
      collectNodes: () => [],
      regenerateIdempotencyKey: () => 'bazis-retry-key',
    }),
  });
  currentHooks = {
    exportToDrive: useOrderExport().exportToDrive,
    saveOrder: orderSave.saveOrder,
  };
  return null;
}

describe('real order operation auth ownership', () => {
  let renderer: ReactTestRenderer;

  beforeEach(() => {
    clearWorkspaceOperationPins();
    authSession.clear();
    authSession.setUser(actor(1));
    vi.clearAllMocks();
    act(() => {
      renderer = create(<Harness />);
    });
  });

  it('quarantines backend save completion and success toast after A→B', async () => {
    let resolveSave!: (value: number) => void;
    mocks.saveOrderViaBackend.mockReturnValueOnce(new Promise<number>((resolve) => {
      resolveSave = resolve;
    }));
    const values = { header: {} } as OrderFormValues;
    const operation = runPageOwnedWorkspaceOperation(
      '/orders/edit/42',
      'order-save',
      () => currentHooks.saveOrder(values, true),
    );
    await vi.waitFor(() => expect(mocks.saveOrderViaBackend).toHaveBeenCalledOnce());

    authSession.setUser(actor(2));
    let caught: unknown;
    await act(async () => {
      resolveSave(42);
      try {
        await operation;
      } catch (error) {
        caught = error;
      }
    });

    expect(caught).toBeInstanceOf(WorkspaceOperationOwnershipLostError);
    expect(mocks.notificationSuccess).not.toHaveBeenCalled();
    expect(mocks.notificationError).not.toHaveBeenCalled();
    renderer.unmount();
  });

  it('quarantines backend export completion and toast after scope revoke', async () => {
    let resolveExport!: (value: { success: boolean; fileName: string }) => void;
    mocks.exportOrderToGoogleDrive.mockReturnValueOnce(new Promise((resolve) => {
      resolveExport = resolve;
    }));
    const operation = runPageOwnedWorkspaceOperation(
      '/orders/edit/42',
      'order-excel-export',
      (owner) => currentHooks.exportToDrive({
        order_id: 42,
        order_name: 'A-42',
        order_date: '2026-08-16',
      }, owner),
    );
    await vi.waitFor(() => expect(mocks.exportOrderToGoogleDrive).toHaveBeenCalledOnce());

    authSession.setUser(actor(1, ['orders.view']));
    let caught: unknown;
    await act(async () => {
      resolveExport({ success: true, fileName: 'A-42.xlsx' });
      try {
        await operation;
      } catch (error) {
        caught = error;
      }
    });

    expect(caught).toBeInstanceOf(WorkspaceOperationOwnershipLostError);
    expect(mocks.messageSuccess).not.toHaveBeenCalled();
    expect(mocks.messageError).not.toHaveBeenCalled();
    renderer.unmount();
  });

  it('pins duplicate-name retry, blocks real tab close and quarantines A→B completion', async () => {
    vi.stubGlobal('localStorage', createMemoryStorage());
    vi.stubGlobal('sessionStorage', createMemoryStorage());
    const duplicate = new ApiError({
      code: 'ORDER_NAME_DUPLICATE',
      message: 'duplicate',
      status: 409,
      details: { existingOrderId: 41, suggestedOrderName: 'A-42-1' },
    });
    let resolveRetry!: (value: number) => void;
    mocks.saveOrderViaBackend
      .mockRejectedValueOnce(duplicate)
      .mockReturnValueOnce(new Promise<number>((resolve) => {
        resolveRetry = resolve;
      }));
    await act(async () => {
      await currentHooks.saveOrder({ order_name: 'A-42', header: {} } as OrderFormValues, true);
    });
    const confirm = mocks.modalConfirm.mock.calls[0][0] as { onOk: () => void };
    const tabStore = await import('../stores/tabStore');
    const key = '/orders/edit/42';
    tabStore.useTabStore.getState().openTab({
      key,
      path: key,
      label: '42',
      resource: 'orders_view',
    });

    act(() => confirm.onOk());
    await vi.waitFor(() => expect(mocks.saveOrderViaBackend).toHaveBeenCalledTimes(2));
    expect(hasWorkspaceOperationPins(key)).toBe(true);
    expect(tabStore.useTabStore.getState().closeTab(key)).toBe(false);
    expect(tabStore.useTabStore.getState().tabs.some((tab) => tab.key === key)).toBe(true);

    authSession.setUser(actor(2));
    act(() => resolveRetry(42));
    await vi.waitFor(() => expect(hasWorkspaceOperationPins(key)).toBe(false));
    expect(mocks.notificationSuccess).not.toHaveBeenCalled();

    renderer.unmount();
    vi.unstubAllGlobals();
  });

  it('does not start duplicate-name retry after its page owner unmounts', async () => {
    const duplicate = new ApiError({
      code: 'ORDER_NAME_DUPLICATE',
      message: 'duplicate',
      status: 409,
      details: { existingOrderId: 41, suggestedOrderName: 'A-42-1' },
    });
    mocks.saveOrderViaBackend.mockRejectedValueOnce(duplicate);

    await act(async () => {
      await currentHooks.saveOrder({ order_name: 'A-42', header: {} } as OrderFormValues, true);
    });
    const confirm = mocks.modalConfirm.mock.calls[0][0] as { onOk: () => void };
    act(() => renderer.unmount());
    act(() => confirm.onOk());
    await act(async () => {
      await Promise.resolve();
    });

    expect(mocks.saveOrderViaBackend).toHaveBeenCalledTimes(1);
    expect(hasWorkspaceOperationPins('/orders/edit/42')).toBe(false);
  });

  it('does not start Bazis duplicate-name retry after its page owner unmounts', async () => {
    act(() => renderer.unmount());
    act(() => {
      renderer = create(<BazisHarness />);
    });
    const duplicate = new ApiError({
      code: 'ORDER_NAME_DUPLICATE',
      message: 'duplicate',
      status: 409,
      details: { existingOrderId: 41, suggestedOrderName: 'A-42-1' },
    });
    mocks.bazisCreateOrderFromDraft.mockRejectedValueOnce(duplicate);
    const values = {
      header: {
        order_name: 'A-42',
        client_id: 1,
        order_date: '2026-08-16',
        order_status_id: 1,
      },
      details: [],
    } as unknown as OrderFormValues;

    await act(async () => {
      await currentHooks.saveOrder(values, false);
    });
    const confirm = mocks.modalConfirm.mock.calls[0][0] as { onOk: () => void };
    act(() => renderer.unmount());
    act(() => confirm.onOk());
    await act(async () => {
      await Promise.resolve();
    });

    expect(mocks.bazisCreateOrderFromDraft).toHaveBeenCalledTimes(1);
    expect(hasWorkspaceOperationPins('/orders/create')).toBe(false);
  });
});

function createMemoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => { data.delete(key); },
    setItem: (key, value) => { data.set(key, String(value)); },
  };
}
