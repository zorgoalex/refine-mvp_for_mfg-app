import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole, type PermissionName } from '../../../permissions/permissions';
import type { OrderFormDataResponseDto } from '../dto/order-form-data.dto';
import type {
  OrderAuditListResponseDto,
  OrderDto,
  OrderListItemDto,
  OrderListResponseDto,
} from '../dto/order.dto';
import type { OrderListQuery, OrderReadRepositoryPort } from './order-query.types';
import { OrderQueryService } from './order-query.service';
import { createOrderDtoForQueryTest } from './order-query.test-helpers';

describe('OrderQueryService', () => {
  it('requires orders.view permission before listing orders', async () => {
    const service = new OrderQueryService({
      reader: readerThatShouldNotBeCalled(),
    });

    await expect(
      service.list({ currentUser: userWithoutOrderView(), query: defaultQuery() }),
    ).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      statusCode: 403,
      details: {
        requiredPermissions: ['orders.view'],
      },
    } satisfies Partial<ApiError>);
  });

  it('delegates list to read repository after permission check', async () => {
    const response: OrderListResponseDto = {
      data: [],
      pagination: { page: 1, pageSize: 25, total: 0, totalPages: 0 },
    };
    const calls: string[] = [];
    const service = new OrderQueryService({
      reader: {
        async listOrders(command) {
          calls.push(`${command.currentUser.id}:${command.query.sortBy}`);
          return response;
        },
        async getOrderById() {
          throw new Error('get should not be called');
        },
        async getOrderAudit() {
          throw new Error('audit should not be called');
        },
        async getOrderFormData() {
          throw new Error('form data should not be called');
        },
      },
    });

    await expect(
      service.list({ currentUser: currentUser(), query: defaultQuery() }),
    ).resolves.toEqual(response);
    expect(calls).toEqual(['manager-id:updatedAt']);
  });

  it.each(['viewer', 'operator'] as const)(
    'masks list financial fields for %s without orders.view_financials',
    async (role) => {
      const response: OrderListResponseDto = {
        data: [createOrderListItemForQueryTest(42)],
        pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 },
      };
      const service = new OrderQueryService({
        reader: {
          async listOrders() {
            return response;
          },
          async getOrderById() {
            throw new Error('get should not be called');
          },
          async getOrderAudit() {
            throw new Error('audit should not be called');
          },
          async getOrderFormData() {
            throw new Error('form data should not be called');
          },
        },
      });

      const result = await service.list({ currentUser: currentUser(role), query: defaultQuery() });
      const item = result.data[0] as Record<string, unknown>;

      expect(item).toMatchObject({
        orderId: 42,
        orderName: 'Test order',
        paymentDate: null,
        paymentStatusId: 0,
        paymentStatusName: '',
        totalAmount: 0,
        discount: 0,
        surcharge: 0,
        finalAmount: 0,
        paidAmount: 0,
        debtAmount: 0,
        partsCount: 5,
        totalArea: 12.5,
      });
    },
  );

  it.each(['viewer', 'operator'] as const)(
    'masks order financial fields and payment rows for %s without orders.view_financials',
    async (role) => {
      const order = createFinancialOrderDtoForQueryTest(42);
      const service = new OrderQueryService({
        reader: {
          async listOrders() {
            throw new Error('list should not be called');
          },
          async getOrderById() {
            return order;
          },
          async getOrderAudit() {
            throw new Error('audit should not be called');
          },
          async getOrderFormData() {
            throw new Error('form data should not be called');
          },
        },
      });

      const result = await service.getById({ currentUser: currentUser(role), orderId: 42 });
      const header = result.header as Record<string, unknown>;
      const totals = result.totals as Record<string, unknown>;

      expect(result.payments).toEqual([]);
      expect(result.details).toMatchObject([
        {
          millingCostPerSqm: null,
          detailCost: 0,
        },
      ]);
      expect(result.requirements).toMatchObject([
        {
          purchasePrice: null,
        },
      ]);
      expect(header).toMatchObject({
        paymentDate: null,
        paymentStatusId: 0,
        totalAmount: 0,
        discount: 0,
        surcharge: 0,
        finalAmount: 0,
        paidAmount: 0,
        partsCount: 5,
        totalArea: 12.5,
      });
      expect(totals).toEqual({
        totalAmount: 0,
        finalAmount: 0,
        paidAmount: 0,
        debtAmount: 0,
        partsCount: 5,
        totalArea: 12.5,
      });
    },
  );

  it.each([
    { sortBy: 'paymentStatusName' as const },
    { sortBy: 'finalAmount' as const },
    { sortBy: 'paidAmount' as const },
    { sortBy: 'debtAmount' as const },
    { paymentStatusId: 2 },
  ])('rejects unauthorized financial list query controls %o', async (queryOverride) => {
    const service = new OrderQueryService({
      reader: readerThatShouldNotBeCalled(),
    });

    await expect(
      service.list({
        currentUser: currentUser('viewer'),
        query: defaultQuery(queryOverride),
      }),
    ).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      statusCode: 403,
      details: {
        requiredPermissions: ['orders.view_financials'],
      },
    } satisfies Partial<ApiError>);
  });

  it('preserves order financial fields for manager with orders.view_financials', async () => {
    const listItem = createOrderListItemForQueryTest(42);
    const order = createFinancialOrderDtoForQueryTest(42);
    const service = new OrderQueryService({
      reader: {
        async listOrders() {
          return {
            data: [listItem],
            pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 },
          };
        },
        async getOrderById() {
          return order;
        },
        async getOrderAudit() {
          throw new Error('audit should not be called');
        },
        async getOrderFormData() {
          throw new Error('form data should not be called');
        },
      },
    });

    await expect(
      service.list({ currentUser: currentUser('manager'), query: defaultQuery() }),
    ).resolves.toEqual({
      data: [listItem],
      pagination: { page: 1, pageSize: 25, total: 1, totalPages: 1 },
    });
    await expect(
      service.getById({ currentUser: currentUser('manager'), orderId: 42 }),
    ).resolves.toBe(order);
  });

  it('requires payments.view in addition to finance visibility for nested payment rows', async () => {
    const order = createFinancialOrderDtoForQueryTest(42);
    const service = new OrderQueryService({
      reader: {
        async listOrders() {
          throw new Error('list should not be called');
        },
        async getOrderById() {
          return order;
        },
        async getOrderAudit() {
          throw new Error('audit should not be called');
        },
        async getOrderFormData() {
          throw new Error('form data should not be called');
        },
      },
    });

    const result = await service.getById({
      currentUser: userWithPermissions('viewer', ['orders.view', 'orders.view_financials']),
      orderId: 42,
    });

    expect(result.payments).toEqual([]);
    expect(result.header.totalAmount).toBe(1000);
    expect(result.totals.finalAmount).toBe(950);
  });

  it('keeps nested payment rows when both finance visibility and payments.view are present', async () => {
    const order = createFinancialOrderDtoForQueryTest(42);
    const service = new OrderQueryService({
      reader: {
        async listOrders() {
          throw new Error('list should not be called');
        },
        async getOrderById() {
          return order;
        },
        async getOrderAudit() {
          throw new Error('audit should not be called');
        },
        async getOrderFormData() {
          throw new Error('form data should not be called');
        },
      },
    });

    const result = await service.getById({
      currentUser: userWithPermissions('viewer', ['orders.view', 'orders.view_financials', 'payments.view']),
      orderId: 42,
    });

    expect(result.payments).toEqual(order.payments);
  });

  it('returns order by id and maps missing order to ORDER_NOT_FOUND', async () => {
    const order = createOrderDtoForQueryTest(42);
    const service = new OrderQueryService({
      reader: {
        async listOrders() {
          throw new Error('list should not be called');
        },
        async getOrderById(command) {
          return command.orderId === 42 ? order : null;
        },
        async getOrderAudit() {
          throw new Error('audit should not be called');
        },
        async getOrderFormData() {
          throw new Error('form data should not be called');
        },
      },
    });

    await expect(service.getById({ currentUser: currentUser(), orderId: 42 })).resolves.toBe(
      order,
    );
    await expect(service.getById({ currentUser: currentUser(), orderId: 99 })).rejects.toMatchObject({
      code: 'ORDER_NOT_FOUND',
      statusCode: 404,
      details: { orderId: 99 },
    } satisfies Partial<ApiError>);
  });

  it('requires orders.view permission before loading order form data', async () => {
    const service = new OrderQueryService({
      reader: readerThatShouldNotBeCalled(),
    });

    await expect(
      service.getFormData({ currentUser: userWithoutOrderView() }),
    ).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      statusCode: 403,
      details: {
        requiredPermissions: ['orders.view'],
      },
    } satisfies Partial<ApiError>);
  });

  it('requires orders.view_audit permission before loading order audit', async () => {
    const service = new OrderQueryService({
      reader: readerThatShouldNotBeCalled(),
    });

    await expect(
      service.getAudit({
        currentUser: currentUser(),
        orderId: 42,
        page: 1,
        pageSize: 50,
        requestId: 'request-audit-1',
      }),
    ).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      statusCode: 403,
      details: {
        requiredPermissions: ['orders.view_audit'],
      },
    } satisfies Partial<ApiError>);
  });

  it('requires finance visibility before loading order audit', async () => {
    const service = new OrderQueryService({
      reader: readerThatShouldNotBeCalled(),
    });

    await expect(
      service.getAudit({
        currentUser: userWithPermissions('viewer', ['orders.view', 'orders.view_audit']),
        orderId: 42,
        page: 1,
        pageSize: 50,
        requestId: 'request-audit-1',
      }),
    ).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      statusCode: 403,
      details: {
        requiredPermissions: ['orders.view_financials'],
      },
    } satisfies Partial<ApiError>);
  });

  it('checks order existence and delegates audit loading after permission checks', async () => {
    const order = createOrderDtoForQueryTest(42);
    const response: OrderAuditListResponseDto = {
      data: [],
      pagination: { page: 1, pageSize: 50, total: 0, totalPages: 1 },
      requestId: 'request-audit-1',
    };
    const calls: string[] = [];
    const service = new OrderQueryService({
      reader: {
        async listOrders() {
          throw new Error('list should not be called');
        },
        async getOrderById(command) {
          calls.push(`get:${command.orderId}`);
          return command.orderId === 42 ? order : null;
        },
        async getOrderAudit(command) {
          calls.push(`audit:${command.orderId}:${command.page}:${command.pageSize}`);
          return response;
        },
        async getOrderFormData() {
          throw new Error('form data should not be called');
        },
      },
    });

    await expect(
      service.getAudit({
        currentUser: currentUserWithAuditPermission(),
        orderId: 42,
        page: 1,
        pageSize: 50,
        requestId: 'request-audit-1',
      }),
    ).resolves.toBe(response);
    await expect(
      service.getAudit({
        currentUser: currentUserWithAuditPermission(),
        orderId: 99,
        page: 1,
        pageSize: 50,
        requestId: 'request-audit-2',
      }),
    ).rejects.toMatchObject({
      code: 'ORDER_NOT_FOUND',
      statusCode: 404,
      details: { orderId: 99 },
    } satisfies Partial<ApiError>);
    expect(calls).toEqual(['get:42', 'audit:42:1:50', 'get:99']);
  });

  it('delegates form data loading to read repository after permission check', async () => {
    const response = createOrderFormDataResponse();
    const calls: string[] = [];
    const service = new OrderQueryService({
      reader: {
        async listOrders() {
          throw new Error('list should not be called');
        },
        async getOrderById() {
          throw new Error('get should not be called');
        },
        async getOrderAudit() {
          throw new Error('audit should not be called');
        },
        async getOrderFormData(command) {
          calls.push(`form-data:${command.currentUser.id}`);
          return response;
        },
      },
    });

    await expect(service.getFormData({ currentUser: currentUser() })).resolves.toBe(response);
    expect(calls).toEqual(['form-data:manager-id']);
  });

  it('returns next order name only to users allowed to create orders', async () => {
    const service = new OrderQueryService({
      reader: readerThatShouldNotBeCalled(),
      nameSuggestions: {
        async getNextOrderName() {
          return '2561';
        },
      },
    });

    await expect(service.getNextOrderName({ currentUser: currentUser() })).resolves.toEqual({
      suggestedOrderName: '2561',
    });
    await expect(
      service.getNextOrderName({ currentUser: userWithoutOrderView() }),
    ).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      details: { requiredPermissions: ['orders.create'] },
    });
  });

  it('masks finance and payment reference form data without finance visibility', async () => {
    const response = createOrderFormDataResponse();
    const service = new OrderQueryService({
      reader: {
        async listOrders() {
          throw new Error('list should not be called');
        },
        async getOrderById() {
          throw new Error('get should not be called');
        },
        async getOrderAudit() {
          throw new Error('audit should not be called');
        },
        async getOrderFormData() {
          return response;
        },
      },
    });

    await expect(service.getFormData({ currentUser: currentUser('operator') })).resolves.toMatchObject({
      millingTypes: [{ id: 3, name: 'Modern', costPerSqm: null }],
      paymentStatuses: [],
      paymentTypes: [],
    });
  });

  it('returns only allowed order statuses in form data for packer', async () => {
    const response = createOrderFormDataResponse();
    response.orderStatuses = [
      { id: 1, name: 'Новый', color: '#ffffff' },
      { id: 6, name: 'Готов к выдаче', color: '#00ff00' },
      { id: 7, name: 'Выдан', color: '#0000ff' },
    ];
    const service = new OrderQueryService({
      reader: {
        async listOrders() {
          throw new Error('list should not be called');
        },
        async getOrderById() {
          throw new Error('get should not be called');
        },
        async getOrderAudit() {
          throw new Error('audit should not be called');
        },
        async getOrderFormData() {
          return response;
        },
      },
    });

    await expect(service.getFormData({ currentUser: currentUser('packer') })).resolves.toEqual({
      clients: [],
      materials: [],
      millingTypes: [],
      edgeTypes: [],
      films: [],
      orderStatuses: [
        { id: 6, name: 'Готов к выдаче', color: '#00ff00' },
        { id: 7, name: 'Выдан', color: '#0000ff' },
      ],
      paymentStatuses: [],
      paymentTypes: [],
      productionStatuses: [],
      workshops: [],
      employees: [],
      units: [],
    });
  });

  it('omits sheetMaterialTypes for a caller without sheet_materials.view', async () => {
    const response = createOrderFormDataResponse();
    const service = new OrderQueryService({
      reader: {
        async listOrders() {
          throw new Error('list should not be called');
        },
        async getOrderById() {
          throw new Error('get should not be called');
        },
        async getOrderAudit() {
          throw new Error('audit should not be called');
        },
        async getOrderFormData() {
          return response;
        },
      },
    });

    // orders.view + finance but NOT sheet_materials.view (e.g. a worker scope).
    const result = await service.getFormData({
      currentUser: userWithPermissions('worker', ['orders.view', 'orders.view_financials']),
    });
    expect(result.sheetMaterialTypes).toBeUndefined();
    // finance not masked here, so the rest is intact
    expect(result.materials.length).toBeGreaterThan(0);
  });

  it('attaches sheetMaterialTypes for a caller with sheet_materials.view', async () => {
    const response = createOrderFormDataResponse();
    const service = new OrderQueryService({
      reader: {
        async listOrders() {
          throw new Error('list should not be called');
        },
        async getOrderById() {
          throw new Error('get should not be called');
        },
        async getOrderAudit() {
          throw new Error('audit should not be called');
        },
        async getOrderFormData() {
          return response;
        },
      },
    });

    const result = await service.getFormData({
      currentUser: userWithPermissions('manager', [
        'orders.view',
        'orders.view_financials',
        'sheet_materials.view',
      ]),
    });
    expect(result.sheetMaterialTypes).toEqual([
      { id: 20, name: 'МДФ 16 мм', widthMm: 2800, heightMm: 2070, isActive: true },
    ]);
  });
});

function currentUser(role: CurrentUser['role'] = 'manager'): CurrentUser {
  return {
    id: `${role}-id`,
    username: role,
    role,
    roleId: role === 'viewer' ? 100 : role === 'operator' ? 11 : 10,
    permissions: getPermissionsForRole(role),
  };
}

function userWithPermissions(role: CurrentUser['role'], permissions: PermissionName[]): CurrentUser {
  return {
    id: `${role}-custom-id`,
    username: `${role}_custom`,
    role,
    roleId: role === 'viewer' ? 100 : role === 'operator' ? 11 : 10,
    permissions,
  };
}

function userWithoutOrderView(): CurrentUser {
  return {
    id: 'no-view',
    username: 'no-view',
    role: 'viewer',
    roleId: 100,
    permissions: [],
  };
}

function currentUserWithAuditPermission(): CurrentUser {
  return {
    id: 'top-manager-id',
    username: 'top-manager',
    role: 'top_manager',
    roleId: 15,
    permissions: getPermissionsForRole('top_manager'),
  };
}

function defaultQuery(overrides: Partial<OrderListQuery> = {}): OrderListQuery {
  return {
    page: 1,
    pageSize: 25,
    sortBy: 'updatedAt' as const,
    sortOrder: 'desc' as const,
    onlyMyOrders: false,
    ...overrides,
  };
}

function readerThatShouldNotBeCalled(): OrderReadRepositoryPort {
  return {
    async listOrders() {
      throw new Error('list should not be called');
    },
    async getOrderById() {
      throw new Error('getById should not be called');
    },
    async getOrderAudit() {
      throw new Error('getOrderAudit should not be called');
    },
    async getOrderFormData() {
      throw new Error('getOrderFormData should not be called');
    },
  };
}

function createOrderFormDataResponse(): OrderFormDataResponseDto {
  return {
    clients: [{ id: 1, name: 'Client' }],
    materials: [{ id: 2, name: 'MDF', unitId: 1 }],
    millingTypes: [{ id: 3, name: 'Modern', costPerSqm: 120 }],
    edgeTypes: [{ id: 4, name: 'PVC' }],
    films: [{ id: 5, name: 'White' }],
    orderStatuses: [{ id: 6, name: 'New', color: '#ffffff' }],
    paymentStatuses: [{ id: 7, name: 'Unpaid', code: 'unpaid', color: '#ff0000' }],
    paymentTypes: [{ id: 8, name: 'Cash' }],
    productionStatuses: [{ id: 9, name: 'Cut', code: 'cut', color: '#00ff00' }],
    workshops: [{ id: 10, name: 'Workshop' }],
    employees: [{ id: 11, fullName: 'Employee' }],
    units: [{ id: 12, code: 'pcs', name: 'Pieces', symbol: 'pcs' }],
    sheetMaterialTypes: [
      { id: 20, name: 'МДФ 16 мм', widthMm: 2800, heightMm: 2070, isActive: true },
    ],
  };
}

function createFinancialOrderDtoForQueryTest(orderId: number): OrderDto {
  const order = createOrderDtoForQueryTest(orderId);

  return {
    ...order,
    header: {
      ...order.header,
      paymentStatusId: 2,
      paymentDate: '2026-05-01',
      totalAmount: 1000,
      discount: 100,
      surcharge: 50,
      finalAmount: 950,
      paidAmount: 400,
      partsCount: 5,
      totalArea: 12.5,
    },
    details: [
      {
        id: 200,
        orderId,
        detailNumber: 1,
        detailName: 'Paid detail',
        height: 1000,
        width: 500,
        quantity: 2,
        materialId: 1001,
        millingTypeId: 1001,
        edgeTypeId: 1001,
        filmId: null,
        area: 1,
        millingCostPerSqm: 2500,
        detailCost: 5000,
        priority: 100,
        productionStatusId: null,
        jointOrderId: null,
        note: null,
        linkCuttingFile: null,
        linkCuttingImageFile: null,
        linkCadFile: null,
        linkPdfFile: null,
        refKey1c: null,
      },
    ],
    payments: [
      {
        id: 300,
        orderId,
        typePaidId: 1,
        amount: 400,
        paymentDate: '2026-05-01',
        notes: 'advance',
        refKey1c: null,
      },
    ],
    requirements: [
      {
        id: 400,
        orderId,
        resourceType: 'material',
        materialId: 1001,
        filmId: null,
        edgeTypeId: null,
        requiredQuantity: 2,
        unitId: 1001,
        wastePercentage: null,
        finalQuantity: null,
        requirementStatusId: 1001,
        supplierId: null,
        purchasePrice: 1500,
        requisitionId: null,
        warehouseId: null,
        reservedAt: null,
        consumedAt: null,
        notes: null,
        calculationDetails: null,
        refKey1c: null,
      },
    ],
    totals: {
      totalAmount: 1000,
      finalAmount: 950,
      paidAmount: 400,
      debtAmount: 550,
      partsCount: 5,
      totalArea: 12.5,
    },
  };
}

function createOrderListItemForQueryTest(orderId: number): OrderListItemDto {
  return {
    orderId,
    orderName: 'Test order',
    projectId: 2001,
    projectCode: 'ФК26',
    fullNumber: 'ФК26-Test order',
    clientId: 1001,
    clientName: 'Test client',
    orderDate: '2026-04-30',
    plannedCompletionDate: null,
    completionDate: null,
    issueDate: null,
    paymentDate: '2026-05-01',
    orderStatusId: 1001,
    orderStatusName: 'New',
    paymentStatusId: 2,
    paymentStatusName: 'Partial',
    productionStatusId: null,
    productionStatusName: null,
    priority: 100,
    totalAmount: 1000,
    discount: 100,
    surcharge: 50,
    finalAmount: 950,
    paidAmount: 400,
    debtAmount: 550,
    partsCount: 5,
    totalArea: 12.5,
    managerId: 10,
    notes: null,
    materialIds: [],
    materialNames: [],
    basisProjects: [],
    bazisCutNumbers: [],
    cutNumbers: [],
    bathCutNumbers: [],
    filmNames: [],
    sheetMaterialTypeIds: [],
    headerMaterialName: null,
    headerSheetMaterialTypeId: null,
    millingTypeId: null,
    millingTypeName: null,
    dowelingOrderId: null,
    dowelingOrderName: null,
    designEngineerId: null,
    passedProductionStatusCodes: [],
    primaryGroup: null,
    groups: [],
    createdBy: 15,
    editedBy: 16,
    updatedAt: '2026-04-30T00:00:00.000Z',
    version: 1,
  };
}
