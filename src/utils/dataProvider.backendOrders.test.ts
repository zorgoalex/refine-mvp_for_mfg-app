import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listOrders = vi.fn();
const getOrderById = vi.fn();
const deleteOrder = vi.fn();

describe('dataProvider backend orders read routing', () => {
  beforeEach(() => {
    vi.resetModules();
    listOrders.mockReset();
    getOrderById.mockReset();
    deleteOrder.mockReset();
    vi.doMock('../config/featureFlags', () => ({
      featureFlags: {
        useBackendAuth: true,
        useBackendPermissions: true,
        useBackendOrdersRead: true,
        useBackendOrdersWrite: true,
        useBackendPayments: false,
        useBackendClientPhones: false,
        useBackendProductionActions: false,
        useBackendOrderExport: false,
        useBackendGroups: true,
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
        delete: deleteOrder,
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
          plannedCompletionDate: '2026-05-08',
          orderStatusId: 3,
          orderStatusName: 'New',
          paymentStatusId: 1,
          paymentStatusName: 'Unpaid',
          productionStatusId: 5,
          productionStatusName: 'Cutting',
          paymentDate: '2026-05-02',
          priority: 100,
          notes: 'Backend note',
          totalAmount: 100,
          finalAmount: 100,
          paidAmount: 0,
          debtAmount: 100,
          partsCount: 2,
          totalArea: 0.4,
          materialIds: [10],
          materialNames: ['MDF 16'],
          millingTypeId: 20,
          millingTypeName: 'Modern',
          dowelingOrderId: 30,
          dowelingOrderName: '1368',
          designEngineerId: 40,
          passedProductionStatusCodes: ['cut', 'paint'],
          primaryGroup: {
            id: '11111111-1111-4111-8111-111111111111',
            code: 'PRJ-001',
            name: 'Group',
            relationType: 'main',
            isPrimary: true,
            validFrom: '2026-05-01T00:00:00.000Z',
          },
          groups: [
            {
              id: '11111111-1111-4111-8111-111111111111',
              code: 'PRJ-001',
              name: 'Group',
              relationType: 'main',
              isPrimary: true,
              validFrom: '2026-05-01T00:00:00.000Z',
            },
          ],
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
        { field: 'group_ids', operator: 'in', value: ['11111111-1111-4111-8111-111111111111'] },
        { field: 'group_mode', operator: 'eq', value: 'primary' },
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
      groupIds: ['11111111-1111-4111-8111-111111111111'],
      groupMode: 'primary',
    });
    expect(result).toMatchObject({
      total: 1,
      data: [
        {
          order_id: 15,
          order_name: 'Order A',
          client_id: 12,
          client_name: 'Client A',
          planned_completion_date: '2026-05-08',
          final_amount: 100,
          payment_date: '2026-05-02',
          notes: 'Backend note',
          material_names: ['MDF 16'],
          material_name: 'MDF 16',
          milling_type_id: 20,
          milling_type_name: 'Modern',
          doweling_order_id: 30,
          doweling_order_name: '1368',
          design_engineer_id: 40,
          passed_production_status_codes: ['cut', 'paint'],
          primary_group: {
            id: '11111111-1111-4111-8111-111111111111',
            code: 'PRJ-001',
            name: 'Group',
            relationType: 'main',
            isPrimary: true,
            validFrom: '2026-05-01T00:00:00.000Z',
          },
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

  it('routes calendar planned completion date filters to backend orders', async () => {
    const makeOrder = (orderId: number) => ({
      orderId,
      orderName: `Order ${orderId}`,
      clientId: 1,
      clientName: 'Client',
      orderDate: '2026-08-01',
      plannedCompletionDate: '2026-08-20',
      orderStatusId: 1,
      orderStatusName: 'New',
      updatedAt: '2026-08-20T00:00:00.000Z',
      version: 1,
    });
    listOrders.mockImplementation(async ({ page }: { page: number }) => ({
      data: Array.from(
        { length: page < 3 ? 200 : 50 },
        (_, index) => makeOrder((page - 1) * 200 + index + 1),
      ),
      pagination: { page, pageSize: 200, total: 450, totalPages: 3 },
    }));
    const { dataProvider } = await import('./dataProvider');

    const result = await dataProvider('').getList({
      resource: 'orders_view',
      pagination: { current: 1, pageSize: 1000 },
      sorters: [
        { field: 'planned_completion_date', order: 'asc' },
        { field: 'order_id', order: 'asc' },
      ],
      filters: [
        { field: 'planned_completion_date', operator: 'gte', value: '2026-08-17' },
        { field: 'planned_completion_date', operator: 'lte', value: '2026-08-23' },
      ],
    });

    expect(listOrders).toHaveBeenCalledTimes(3);
    for (const page of [1, 2, 3]) {
      expect(listOrders).toHaveBeenCalledWith({
        page,
        pageSize: 200,
        sortBy: 'plannedCompletionDate',
        sortOrder: 'asc',
        plannedCompletionDateFrom: '2026-08-17',
        plannedCompletionDateTo: '2026-08-23',
      });
    }
    expect(result.total).toBe(450);
    expect(result.data).toHaveLength(450);
    expect(result.data[0]).toMatchObject({ order_id: 1 });
    expect(result.data[449]).toMatchObject({ order_id: 450 });
  });

  it('routes orders delete to backend with required version and never calls Hasura', async () => {
    deleteOrder.mockResolvedValue({
      success: true,
      orderId: 15,
      auditId: 'audit-delete-1',
      requestId: 'request-delete-1',
    });
    const { dataProvider } = await import('./dataProvider');

    await expect(
      dataProvider('').deleteOne({
        resource: 'orders',
        id: 15,
        meta: { version: 4, idempotencyKey: 'order-delete-key-1' },
      }),
    ).resolves.toEqual({ data: { order_id: 15 } });

    expect(deleteOrder).toHaveBeenCalledWith(15, {
      version: 4,
      idempotencyKey: 'order-delete-key-1',
    });
  });

  it('fails backend orders delete before Hasura fallback when version is missing', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { dataProvider } = await import('./dataProvider');

    await expect(
      dataProvider('').deleteOne({ resource: 'orders', id: 15 }),
    ).rejects.toMatchObject({
      message: 'Order version is required for backend delete',
      statusCode: 400,
    });

    expect(deleteOrder).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
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
