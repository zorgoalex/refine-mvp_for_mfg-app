import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authSession } from '../api/authSession';
import type { UserIdentity } from '../types/auth';
import type { OrderFormValues } from '../types/orders';
import { ApiError } from '../api/apiError';
import { mapOrderFormToSaveOrderDto } from '../api/mappers/orderMapper';
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
  modalWarning: vi.fn(),
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
    warning: mocks.modalWarning,
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

function createFormValues(): OrderFormValues {
  return {
    header: {
      order_id: 42, order_name: 'A-42', client_id: 1, order_date: '2026-09-12',
      priority: 100, order_status_id: 1, payment_status_id: 1,
      discount: 0, paid_amount: 500, notes: 'Тест: сохранить поля', version: 4,
    },
    details: [{
      temp_id: -1, detail_number: 1, height: 500, width: 400, quantity: 2,
      area: 0.2, material_id: null, sheet_material_type_id: 1, milling_type_id: 1, edge_type_id: 1,
      milling_cost_per_sqm: 500, detail_cost: 200, priority: 100,
    }],
    payments: [{ payment_id: 71, type_paid_id: 1, amount: 500, payment_date: '2026-09-12' }],
    workshops: [{ order_workshop_id: 81, workshop_id: 1, production_status_id: 1 }],
    requirements: [{ requirement_id: 91, resource_type: 'film', film_id: 1, required_quantity: 2, unit_id: 1, requirement_status_id: 1 }],
    dowelingLinks: [{ order_doweling_link_id: 101, order_id: 42, doweling_order_id: 31 }],
    catalogLines: [], hdfDetails: [], dirtyHdfDetailIds: [],
    deletedDetails: [2], deletedPayments: [72], deletedWorkshops: [82],
    deletedRequirements: [92], deletedDowelingLinks: [102],
    deletedHdfDetails: [112], deletedCatalogLineIds: [122],
    pdfImportCandidateTempIds: [-1], version: 5, idempotencyKey: 'test-order-save-key',
  };
}

function duplicateName(suggestedOrderName: string | null = 'A-42-1') {
  return new ApiError({
    code: 'ORDER_NAME_DUPLICATE', message: 'duplicate', status: 409,
    details: { existingOrderId: 41, suggestedOrderName },
  });
}

function confirmation(index = 0): { content: string; cancelText: string; onOk: () => void; onCancel?: () => void } {
  expect(mocks.modalConfirm.mock.calls.length).toBeGreaterThan(index);
  return mocks.modalConfirm.mock.calls[index][0];
}

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
    mocks.saveOrderViaBackend.mockReset();
    mocks.bazisCreateOrderFromDraft.mockReset();
    act(() => {
      renderer = create(<Harness />);
    });
  });

  afterEach(() => {
    act(() => renderer.unmount());
    clearWorkspaceOperationPins();
    authSession.clear();
    vi.unstubAllGlobals();
  });

  it('quarantines backend save completion and success toast after A→B', async () => {
    let resolveSave!: (value: number) => void;
    mocks.saveOrderViaBackend.mockReturnValueOnce(new Promise<number>((resolve) => {
      resolveSave = resolve;
    }));
    const values = createFormValues();
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
      await currentHooks.saveOrder(createFormValues(), true);
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
      await currentHooks.saveOrder(createFormValues(), true);
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

  it('shows the original nested order name in duplicate confirmation', async () => {
    mocks.saveOrderViaBackend.mockRejectedValueOnce(duplicateName());
    await act(async () => { await currentHooks.saveOrder(createFormValues(), true); });
    expect(confirmation().content).toContain('Номер «A-42»');
    expect(confirmation().content).toContain('заказом #41');
    expect(confirmation().content).toContain('Свободный номер: A-42-1');
  });

  it.each([false, true])('retries with an immutable nested name and unchanged DTO fields (isEdit=%s)', async (isEdit) => {
    const values = createFormValues();
    if (!isEdit) delete values.header.order_id;
    const snapshot = structuredClone(values);
    const originalDto = mapOrderFormToSaveOrderDto(values);
    Object.freeze(values.header);
    Object.freeze(values);
    mocks.saveOrderViaBackend
      .mockRejectedValueOnce(duplicateName())
      .mockResolvedValueOnce(42);
    await act(async () => { await currentHooks.saveOrder(values, isEdit); });
    act(() => confirmation().onOk());
    await vi.waitFor(() => expect(mocks.saveOrderViaBackend).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(hasWorkspaceOperationPins('/orders/edit/42')).toBe(false));

    const retried: OrderFormValues = mocks.saveOrderViaBackend.mock.calls[1][0];
    const retryMode: boolean = mocks.saveOrderViaBackend.mock.calls[1][1];
    expect(retryMode).toBe(isEdit);
    expect(retried.header.order_name).toBe('A-42-1');
    expect(retried).not.toBe(values);
    expect(retried.header).not.toBe(values.header);
    expect(retried).not.toHaveProperty('order_name');
    expect(retried).toEqual({ ...snapshot, header: { ...snapshot.header, order_name: 'A-42-1' } });
    for (const key of [
      'details', 'payments', 'workshops', 'requirements', 'dowelingLinks',
      'catalogLines', 'hdfDetails', 'dirtyHdfDetailIds', 'pdfImportCandidateTempIds',
      'deletedDetails', 'deletedPayments', 'deletedWorkshops', 'deletedRequirements',
      'deletedDowelingLinks', 'deletedHdfDetails', 'deletedCatalogLineIds',
      'version', 'idempotencyKey',
    ] as const) {
      expect(retried[key], key).toBe(values[key]);
    }
    expect(mapOrderFormToSaveOrderDto(retried)).toEqual({
      ...originalDto, header: { ...originalDto.header, orderName: 'A-42-1' },
    });
    expect(values).toEqual(snapshot);
    expect(mocks.notificationSuccess).toHaveBeenCalledOnce();
    expect(mocks.notificationError).not.toHaveBeenCalled();
  });

  it('does not submit another command or mutate the form when confirmation is cancelled', async () => {
    const values = createFormValues();
    const snapshot = structuredClone(values);
    mocks.saveOrderViaBackend.mockRejectedValueOnce(duplicateName());
    await act(async () => { await currentHooks.saveOrder(values, true); });
    const confirm = confirmation();
    expect(confirm.cancelText).toBe('Изменить вручную');
    // Native Modal closes on cancel; the hook deliberately has no cancel-side command.
    expect(confirm.onCancel).toBeUndefined();
    await act(async () => { await Promise.resolve(); });
    expect(mocks.saveOrderViaBackend).toHaveBeenCalledOnce();
    expect(values).toEqual(snapshot);
    expect(mocks.notificationSuccess).not.toHaveBeenCalled();
    expect(hasWorkspaceOperationPins('/orders/edit/42')).toBe(false);
  });

  it('shows the nested original name without retry when no free name is suggested', async () => {
    const values = createFormValues();
    const snapshot = structuredClone(values);
    mocks.saveOrderViaBackend.mockRejectedValueOnce(duplicateName(null));
    await act(async () => { await currentHooks.saveOrder(values, true); });
    expect(mocks.modalConfirm).not.toHaveBeenCalled();
    expect(mocks.modalWarning).toHaveBeenCalledWith(expect.objectContaining({
      content: 'Номер «A-42» уже используется заказом #41. Укажите другой номер заказа.',
    }));
    expect(mocks.saveOrderViaBackend).toHaveBeenCalledOnce();
    expect(values).toEqual(snapshot);
  });

  it('uses each latest suggested name when the retry conflicts again', async () => {
    const values = createFormValues();
    const snapshot = structuredClone(values);
    mocks.saveOrderViaBackend
      .mockRejectedValueOnce(duplicateName('A-42-1'))
      .mockRejectedValueOnce(duplicateName('A-42-2'))
      .mockResolvedValueOnce(42);
    await act(async () => { await currentHooks.saveOrder(values, true); });
    act(() => confirmation().onOk());
    await vi.waitFor(() => expect(mocks.modalConfirm).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(hasWorkspaceOperationPins('/orders/edit/42')).toBe(false));
    expect(confirmation(1).content).toContain('Номер «A-42-1»');
    act(() => confirmation(1).onOk());
    await vi.waitFor(() => expect(mocks.saveOrderViaBackend).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(hasWorkspaceOperationPins('/orders/edit/42')).toBe(false));
    const retryValues: OrderFormValues = mocks.saveOrderViaBackend.mock.calls[2][0];
    expect(mapOrderFormToSaveOrderDto(retryValues).header.orderName).toBe('A-42-2');
    expect(values).toEqual(snapshot);
    expect(mocks.notificationSuccess).toHaveBeenCalledOnce();
  });

  it('reports a retry API failure without false success or form mutation', async () => {
    const values = createFormValues();
    const snapshot = structuredClone(values);
    mocks.saveOrderViaBackend
      .mockRejectedValueOnce(duplicateName())
      .mockRejectedValueOnce(new ApiError({ code: 'INTERNAL_ERROR', message: 'Тест: отказ API', status: 500 }));
    await act(async () => { await currentHooks.saveOrder(values, true); });
    act(() => confirmation().onOk());
    await vi.waitFor(() => expect(mocks.notificationError).toHaveBeenCalledWith(expect.objectContaining({
      description: 'Тест: отказ API',
    })));
    await vi.waitFor(() => expect(hasWorkspaceOperationPins('/orders/edit/42')).toBe(false));
    expect(mocks.saveOrderViaBackend).toHaveBeenCalledTimes(2);
    expect(mocks.notificationSuccess).not.toHaveBeenCalled();
    expect(values).toEqual(snapshot);
  });

  it.each([
    { name: 'actor change', nextActor: actor(2) },
    { name: 'permission revocation', nextActor: actor(1, ['orders.view']) },
  ])('does not retry after $name before confirmation', async ({ nextActor }) => {
    mocks.saveOrderViaBackend.mockRejectedValueOnce(duplicateName());
    await act(async () => { await currentHooks.saveOrder(createFormValues(), true); });
    const confirm = confirmation();
    authSession.setUser(nextActor);
    await act(async () => { confirm.onOk(); await Promise.resolve(); });
    expect(mocks.saveOrderViaBackend).toHaveBeenCalledOnce();
    expect(hasWorkspaceOperationPins('/orders/edit/42')).toBe(false);
    expect(mocks.notificationSuccess).not.toHaveBeenCalled();
  });

  it('preserves Bazis nested-name retry and its regenerated idempotency key', async () => {
    act(() => renderer.unmount());
    act(() => { renderer = create(<BazisHarness />); });
    const values = createFormValues();
    const snapshot = structuredClone(values);
    mocks.bazisCreateOrderFromDraft
      .mockRejectedValueOnce(duplicateName())
      .mockResolvedValueOnce({ orderId: 42 });
    await act(async () => { await currentHooks.saveOrder(values, false); });
    expect(confirmation().content).toContain('Номер «A-42»');
    act(() => confirmation().onOk());
    await vi.waitFor(() => expect(mocks.bazisCreateOrderFromDraft).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(hasWorkspaceOperationPins('/orders/create')).toBe(false));
    const originalDto = mapOrderFormToSaveOrderDto(values);
    expect(mocks.bazisCreateOrderFromDraft.mock.calls[1]).toEqual([7, {
      order: {
        ...originalDto, header: { ...originalDto.header, orderName: 'A-42-1' },
        idempotencyKey: 'bazis-retry-key',
      },
      nodes: [], idempotencyKey: 'bazis-retry-key',
    }]);
    expect(values).toEqual(snapshot);
    expect(mocks.saveOrderViaBackend).not.toHaveBeenCalled();
    expect(mocks.notificationSuccess).toHaveBeenCalledOnce();
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
    const values = createFormValues();

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
