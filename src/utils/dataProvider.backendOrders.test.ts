import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listOrders = vi.fn();
const getOrderById = vi.fn();

describe('dataProvider backend orders read routing', () => {
  beforeEach(() => {
    vi.resetModules();
    listOrders.mockReset();
    getOrderById.mockReset();
    vi.doMock('../config/featureFlags', () => ({
      featureFlags: {
        useBackendAuth: true,
        useBackendPermissions: true,
        useBackendOrdersRead: true,
        useBackendOrdersWrite: false,
        useBackendOrderExport: false,
        useBackendUsers: false,
        useBackendVlm: false,
        useBackendReferences: false,
        enableLegacyHasura: true,
      },
    }));
    vi.doMock('../api/ordersApi', () => ({
      ordersApi: {
        list: listOrders,
        getById: getOrderById,
      },
    }));
    vi.stubGlobal('localStorage', createLocalStorageMock());
  });

  afterEach(() => {
    vi.doUnmock('../config/featureFlags');
    vi.doUnmock('../api/ordersApi');
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('routes orders_view getList to /api/v1 orders query shape when filters are supported', async () => {
    const { authSession } = await import('../api/authSession');
    authSession.setUser({
      id: '7',
      username: 'manager',
      role: 'manager',
      permissions: ['orders.view'],
    });
    listOrders.mockResolvedValue({
      data: [
        {
          orderId: 15,
          orderName: 'Order A',
          clientId: 12,
          clientName: 'Client A',
          orderDate: '2026-05-01',
          orderStatusId: 3,
          orderStatusName: 'New',
          paymentStatusId: 1,
          paymentStatusName: 'Unpaid',
          totalAmount: 100,
          finalAmount: 100,
          paidAmount: 0,
          debtAmount: 100,
          partsCount: 2,
          totalArea: 0.4,
          updatedAt: '2026-05-01T00:00:00.000Z',
          version: 4,
        },
      ],
      pagination: { page: 2, pageSize: 20, total: 1, totalPages: 1 },
    });
    const { dataProvider } = await import('./dataProvider');

    const result = await dataProvider('').getList({
      resource: 'orders_view',
      pagination: { current: 2, pageSize: 20 },
      sorters: [{ field: 'order_date', order: 'desc' }],
      filters: [
        { field: 'order_name', operator: 'contains', value: 'Order A' },
        { field: 'client_id', operator: 'eq', value: 12 },
        { field: 'created_by', operator: 'eq', value: 7 },
      ],
    });

    expect(listOrders).toHaveBeenCalledWith({
      page: 2,
      pageSize: 20,
      sortBy: 'orderDate',
      sortOrder: 'desc',
      search: 'Order A',
      clientId: 12,
      onlyMyOrders: true,
    });
    expect(result).toMatchObject({
      total: 1,
      data: [
        {
          order_id: 15,
          order_name: 'Order A',
          client_id: 12,
          client_name: 'Client A',
          final_amount: 100,
          version: 4,
        },
      ],
    });
  });

  it('routes orders getOne to backend order detail and returns legacy header shape', async () => {
    getOrderById.mockResolvedValue({
      header: {
        orderId: 15,
        orderName: 'Order A',
        clientId: 12,
        clientName: 'Client A',
        orderDate: '2026-05-01',
        orderStatusId: 3,
        orderStatusName: 'New',
        paymentStatusId: 1,
        paymentStatusName: 'Unpaid',
      },
      details: [],
      payments: [],
      workshops: [],
      requirements: [],
      dowelingLinks: [],
      totals: {
        totalAmount: 100,
        discount: 0,
        surcharge: 0,
        finalAmount: 100,
        paidAmount: 0,
        debtAmount: 100,
        partsCount: 0,
        totalArea: 0,
      },
      version: 4,
    });
    const { dataProvider } = await import('./dataProvider');

    const result = await dataProvider('').getOne({ resource: 'orders', id: 15 });

    expect(getOrderById).toHaveBeenCalledWith(15);
    expect(result.data).toMatchObject({
      order_id: 15,
      order_name: 'Order A',
      client_id: 12,
      client_name: 'Client A',
      order_status_name: 'New',
      version: 4,
    });
  });
});

function createLocalStorageMock(): Storage {
  const storage = new Map<string, string>();

  return {
    get length() {
      return storage.size;
    },
    clear: vi.fn(() => storage.clear()),
    getItem: vi.fn((key: string) => storage.get(key) ?? null),
    key: vi.fn((index: number) => Array.from(storage.keys())[index] ?? null),
    removeItem: vi.fn((key: string) => {
      storage.delete(key);
    }),
    setItem: vi.fn((key: string, value: string) => {
      storage.set(key, String(value));
    }),
  };
}
