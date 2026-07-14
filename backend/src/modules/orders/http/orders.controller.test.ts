import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import type { DatabaseService } from '../../../database/database.service';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import type { OrderQueryService } from '../application/order-query.service';
import type { OrderTransactionService } from '../application/order-transaction.service';
import type { OrderFormDataResponseDto } from '../dto/order-form-data.dto';
import type { OrderDto, OrderListResponseDto, RestoreOrderResponseDto } from '../dto/order.dto';
import type { SaveOrderDto } from '../dto/save-order.dto';
import {
  OrdersController,
  parseIdempotencyKeyHeader,
  parseIfMatchVersion,
  parseOrderAuditQuery,
  parseOrderId,
  parseOrderListQuery,
} from './orders.controller';
import type { OrdersRuntimeConfigService } from './orders-runtime-config.service';

describe('OrdersController read endpoints', () => {
  it('fails closed when orders API feature flag is disabled by default', async () => {
    const controller = createController({
      flags: {
        ordersEnabled: false,
        ordersReadOnly: true,
      },
    });

    await expect(controller.list({ user: currentUser() }, {})).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      statusCode: 503,
    } satisfies Partial<ApiError>);
  });

  it('allows reads while orders are in read-only mode', async () => {
    const response: OrderListResponseDto = {
      data: [],
      pagination: { page: 1, pageSize: 20, total: 0, totalPages: 0 },
    };
    const calls: string[] = [];
    const controller = createController({
      flags: {
        ordersEnabled: true,
        ordersReadOnly: true,
      },
      queries: {
        async list(command) {
          calls.push(
            `list:${command.currentUser.id}:${command.query.page}:${command.query.pageSize}:${command.query.sortBy}`,
          );
          return response;
        },
      },
    });

    await expect(
      controller.list({ user: currentUser('viewer-id') }, { page: '1', pageSize: '20' }),
    ).resolves.toEqual(response);
    expect(calls).toEqual(['list:viewer-id:1:20:updatedAt']);
  });

  it('rejects trash list access without orders.delete and records denied audit best-effort', async () => {
    const database = createDatabase();
    const controller = createController({
      flags: {
        ordersEnabled: true,
        ordersReadOnly: true,
      },
      database,
    });

    await expect(
      controller.list(
        { user: currentUser('viewer-id', 'viewer'), requestId: 'request-trash-list-1' },
        { deleted: 'true' },
      ),
    ).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      statusCode: 403,
      details: {
        requiredPermissions: ['orders.delete'],
      },
    } satisfies Partial<ApiError>);

    expect(database.queries).toHaveLength(1);
    expect(database.queries[0]?.text).toContain('INSERT INTO audit_log');
    expect(database.queries[0]?.params).toEqual(
      expect.arrayContaining([
        'orders.list_deleted',
        'order',
        'orders',
        'viewer-id',
        'viewer',
        'viewer',
        'request-trash-list-1',
        'backend-orders-command',
        null,
        'denied',
        'PERMISSION_DENIED',
      ]),
    );
  });

  it('passes deleted=true through to the query service for trash listing', async () => {
    const response: OrderListResponseDto = {
      data: [],
      pagination: { page: 1, pageSize: 20, total: 0, totalPages: 0 },
    };
    const calls: string[] = [];
    const controller = createController({
      flags: {
        ordersEnabled: true,
        ordersReadOnly: true,
      },
      queries: {
        async list(command) {
          calls.push(`list:${String(command.query.deleted)}:${command.query.sortBy}`);
          return response;
        },
      },
    });

    await expect(
      controller.list(
        { user: userWithExtraPermissions('manager-id', 'manager', ['orders.delete']) },
        { deleted: 'true', sortBy: 'deletedAt' },
      ),
    ).resolves.toEqual(response);
    expect(calls).toEqual(['list:true:deletedAt']);
  });

  it('requires authenticated current user before list query service', async () => {
    const controller = createController({
      flags: {
        ordersEnabled: true,
        ordersReadOnly: true,
      },
    });

    await expect(controller.list({}, {})).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
      statusCode: 401,
    } satisfies Partial<ApiError>);
  });

  it('wraps getById response and parses order id', async () => {
    const order = createOrderDto({ orderId: 42 });
    const calls: string[] = [];
    const controller = createController({
      flags: {
        ordersEnabled: true,
        ordersReadOnly: true,
      },
      queries: {
        async getById(command) {
          calls.push(`get:${command.orderId}:${command.currentUser.id}`);
          return order;
        },
      },
    });

    await expect(controller.getById({ user: currentUser('manager-id') }, '42')).resolves.toEqual({
      order,
    });
    expect(calls).toEqual(['get:42:manager-id']);
  });

  it('rejects includeDeleted=true without orders.delete and records denied audit best-effort', async () => {
    const database = createDatabase();
    const controller = createController({
      flags: {
        ordersEnabled: true,
        ordersReadOnly: true,
      },
      database,
    });

    await expect(
      controller.getById(
        { user: currentUser('viewer-id', 'viewer'), requestId: 'request-trash-read-1' },
        '42',
        { includeDeleted: 'true' },
      ),
    ).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      statusCode: 403,
      details: {
        requiredPermissions: ['orders.delete'],
      },
    } satisfies Partial<ApiError>);

    expect(database.queries).toHaveLength(1);
    expect(database.queries[0]?.text).toContain('INSERT INTO audit_log');
    expect(database.queries[0]?.params).toEqual(
      expect.arrayContaining([
        'orders.read_deleted',
        'order',
        '42',
        'viewer-id',
        'viewer',
        'viewer',
        'request-trash-read-1',
        'backend-orders-command',
        42,
        'denied',
        42,
        'PERMISSION_DENIED',
      ]),
    );
  });

  it('passes includeDeleted=true through to the query service', async () => {
    const order = createOrderDto({ orderId: 42 });
    const calls: string[] = [];
    const controller = createController({
      flags: {
        ordersEnabled: true,
        ordersReadOnly: true,
      },
      queries: {
        async getById(command) {
          calls.push(`get:${command.orderId}:${String(command.includeDeleted)}`);
          return order;
        },
      },
    });

    await expect(
      controller.getById(
        { user: userWithExtraPermissions('manager-id', 'manager', ['orders.delete']) },
        '42',
        { includeDeleted: 'true' },
      ),
    ).resolves.toEqual({
      order,
    });
    expect(calls).toEqual(['get:42:true']);
  });

  it('preserves 404 behavior for getById without includeDeleted', async () => {
    const controller = createController({
      flags: {
        ordersEnabled: true,
        ordersReadOnly: true,
      },
      queries: {
        async getById(command) {
          if (command.includeDeleted === true) {
            throw new Error('includeDeleted should stay off in default mode');
          }
          throw new ApiError(404, 'ORDER_NOT_FOUND', 'Заказ не найден', { orderId: command.orderId });
        },
      },
    });

    await expect(
      controller.getById({ user: currentUser('manager-id', 'manager') }, '42'),
    ).rejects.toMatchObject({
      code: 'ORDER_NOT_FOUND',
      statusCode: 404,
      details: { orderId: 42 },
    } satisfies Partial<ApiError>);
  });

  it('returns order audit with current user and request id', async () => {
    const response = {
      data: [],
      pagination: { page: 2, pageSize: 50, total: 0, totalPages: 1 },
      requestId: 'request-audit-1',
    };
    const calls: string[] = [];
    const controller = createController({
      flags: {
        ordersEnabled: true,
        ordersReadOnly: true,
      },
      queries: {
        async getAudit(command) {
          calls.push(
            `audit:${command.orderId}:${command.currentUser.id}:${command.page}:${command.pageSize}:${command.requestId}`,
          );
          return response;
        },
      },
    });

    await expect(
      controller.getAudit(
        { user: currentUser('top-manager-id'), requestId: 'request-audit-1' },
        '42',
        { page: '2' },
      ),
    ).resolves.toBe(response);
    expect(calls).toEqual(['audit:42:top-manager-id:2:50:request-audit-1']);
  });

  it('requires authenticated current user before audit query service', async () => {
    const controller = createController({
      flags: {
        ordersEnabled: true,
        ordersReadOnly: true,
      },
    });

    await expect(controller.getAudit({}, '42', {})).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
      statusCode: 401,
    } satisfies Partial<ApiError>);
  });

  it('returns order form reference data through the read query service', async () => {
    const response = createOrderFormDataResponse();
    const calls: string[] = [];
    const controller = createController({
      flags: {
        ordersEnabled: true,
        ordersReadOnly: true,
      },
      queries: {
        async getFormData(command) {
          calls.push(`form-data:${command.currentUser.id}`);
          return response;
        },
      },
    });

    await expect(controller.getFormData({ user: currentUser('manager-id') })).resolves.toBe(
      response,
    );
    expect(calls).toEqual(['form-data:manager-id']);
  });

  it('requires authenticated current user before form data query service', async () => {
    const controller = createController({
      flags: {
        ordersEnabled: true,
        ordersReadOnly: true,
      },
    });

    await expect(controller.getFormData({})).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
      statusCode: 401,
    } satisfies Partial<ApiError>);
  });

  it('normalizes list query with whitelist defaults', () => {
    expect(
      parseOrderListQuery({
        page: '2',
        pageSize: '50',
        sortBy: 'projectCode',
        sortOrder: 'asc',
        search: '  Order A ',
        clientId: '12',
        projectId: '17',
        orderStatusId: '3',
        paymentStatusId: '4',
        productionStatusId: '5',
        dateFrom: '2026-04-01',
        dateTo: '2026-04-30',
        onlyMyOrders: 'true',
        deleted: 'true',
      }),
    ).toEqual({
      page: 2,
      pageSize: 50,
      sortBy: 'projectCode',
      sortOrder: 'asc',
      search: 'Order A',
      clientId: 12,
      projectId: 17,
      orderStatusId: 3,
      paymentStatusId: 4,
      productionStatusId: 5,
      dateFrom: '2026-04-01',
      dateTo: '2026-04-30',
      onlyMyOrders: true,
      deleted: true,
    });
  });

  it('drops blank projectId and rejects non-positive values like other optional integer filters', () => {
    expect(parseOrderListQuery({ projectId: '' }).projectId).toBeUndefined();
    expect(() => parseOrderListQuery({ projectId: '0' })).toThrow(ApiError);
  });

  it('lowercases and deduplicates groupIds before applying all-mode group filters', () => {
    const groupId = 'abcdefab-cdef-4abc-8def-abcdefabcdef';

    expect(parseOrderListQuery({
      groupIds: `${groupId.toUpperCase()},${groupId}`,
      groupMode: 'all',
    })).toMatchObject({
      groupIds: [groupId],
      groupMode: 'all',
    });
  });

  it('rejects unsupported sort fields as validation errors', () => {
    expect(() => parseOrderListQuery({ sortBy: 'raw_sql_injection' })).toThrow(ApiError);
    expect(() => parseOrderListQuery({ pageSize: '201' })).toThrow(ApiError);
    expect(() => parseOrderListQuery({ dateFrom: '30.04.2026' })).toThrow(ApiError);
    expect(() => parseOrderListQuery({ deleted: 'да' })).toThrow(ApiError);
    expect(() => parseOrderListQuery({ sortBy: 'deletedAt' })).toThrow(ApiError);
    expect(() => parseOrderAuditQuery({ pageSize: '201' })).toThrow(ApiError);
  });
});

describe('OrdersController write endpoints', () => {
  it('fails closed when orders API feature flag is disabled by default', async () => {
    const controller = createController({
      flags: {
        ordersEnabled: false,
        ordersReadOnly: true,
      },
    });

    await expect(controller.create({ user: currentUser() }, createSaveOrderDto())).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      statusCode: 503,
    } satisfies Partial<ApiError>);
  });

  it('blocks writes when orders API is enabled but read-only', async () => {
    const controller = createController({
      flags: {
        ordersEnabled: true,
        ordersReadOnly: true,
      },
    });

    await expect(controller.create({ user: currentUser() }, createSaveOrderDto())).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      statusCode: 503,
      details: {
        feature: 'orders',
        mode: 'read_only',
      },
    } satisfies Partial<ApiError>);
  });

  it('requires authenticated current user before calling transaction service', async () => {
    const controller = createController({
      flags: {
        ordersEnabled: true,
        ordersReadOnly: false,
      },
    });

    await expect(controller.create({}, createSaveOrderDto())).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
      statusCode: 401,
    } satisfies Partial<ApiError>);
  });

  it('delegates create to OrderTransactionService and wraps OrderDto response', async () => {
    const order = createOrderDto({ orderId: 101 });
    const calls: string[] = [];
    const controller = createController({
      flags: {
        ordersEnabled: true,
        ordersReadOnly: false,
      },
      service: {
        async create(command) {
          calls.push(`create:${command.currentUser.id}:${command.dto.header.orderName}`);
          return order;
        },
      },
    });

    await expect(
      controller.create({ user: currentUser('manager-id') }, createSaveOrderDto()),
    ).resolves.toEqual({ order });
    expect(calls).toEqual(['create:manager-id:Test order']);
  });

  it('parses orderId and delegates update to OrderTransactionService', async () => {
    const order = createOrderDto({ orderId: 42 });
    const calls: string[] = [];
    const controller = createController({
      flags: {
        ordersEnabled: true,
        ordersReadOnly: false,
      },
      service: {
        async update(command) {
          calls.push(`update:${command.orderId}:${command.currentUser.id}:${command.dto.version}`);
          return order;
        },
      },
    });

    await expect(
      controller.update({ user: currentUser('manager-id') }, '42', {
        ...createSaveOrderDto(),
        version: 3,
      }),
    ).resolves.toEqual({ order });
    expect(calls).toEqual(['update:42:manager-id:3']);
  });

  it('parses stale-safe delete headers and delegates delete to OrderTransactionService', async () => {
    const calls: string[] = [];
    const response = {
      success: true as const,
      orderId: 42,
      auditId: 'audit-delete-1',
      requestId: 'request-delete-1',
    };
    const controller = createController({
      flags: {
        ordersEnabled: true,
        ordersReadOnly: false,
      },
      service: {
        async delete(command) {
          calls.push(
            `delete:${command.orderId}:${command.currentUser.id}:${command.version}:${command.idempotencyKey}:${command.requestId}`,
          );
          return response;
        },
      },
    });

    await expect(
      controller.delete(
        { user: currentUser('manager-id'), requestId: 'request-delete-1' },
        '42',
        '"3"',
        'order-delete-key-1',
      ),
    ).resolves.toBe(response);
    expect(calls).toEqual(['delete:42:manager-id:3:order-delete-key-1:request-delete-1']);
  });

  it('requires authenticated current user before delete transaction service', async () => {
    const controller = createController({
      flags: {
        ordersEnabled: true,
        ordersReadOnly: false,
      },
    });

    await expect(
      controller.delete({}, '42', '3', 'order-delete-key-1'),
    ).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
      statusCode: 401,
    } satisfies Partial<ApiError>);
  });

  it('rejects missing delete command headers as BAD_REQUEST', () => {
    expect(() => parseIfMatchVersion(undefined)).toThrow(ApiError);
    expect(() => parseIfMatchVersion('raw')).toThrow(ApiError);
    expect(() => parseIfMatchVersion('""')).toThrow(ApiError);
    expect(() => parseIfMatchVersion('" "')).toThrow(ApiError);
    expect(() => parseIfMatchVersion('1e0')).toThrow(ApiError);
    expect(() => parseIfMatchVersion('0x10')).toThrow(ApiError);
    expect(parseIfMatchVersion('"4"')).toBe(4);
    expect(parseIfMatchVersion('0')).toBe(0);

    expect(() => parseIdempotencyKeyHeader(undefined)).toThrow(ApiError);
    expect(() => parseIdempotencyKeyHeader('short')).toThrow(ApiError);
    expect(parseIdempotencyKeyHeader('  order-delete-key-1  ')).toBe('order-delete-key-1');
  });

  it('parses restore headers and delegates restore to OrderTransactionService', async () => {
    const calls: string[] = [];
    const response: RestoreOrderResponseDto = {
      order: createOrderDto({ orderId: 42 }),
      auditId: 'audit-restore-1',
      requestId: 'request-restore-1',
    };
    const controller = createController({
      flags: {
        ordersEnabled: true,
        ordersReadOnly: false,
      },
      service: {
        async restore(command) {
          calls.push(
            `restore:${command.orderId}:${command.currentUser.id}:${command.version}:${command.idempotencyKey}:${command.orderName}:${command.requestId}`,
          );
          return response;
        },
      },
    });

    await expect(
      controller.restore(
        { user: currentUser('manager-id'), requestId: 'request-restore-1' },
        '42',
        '"3"',
        'order-restore-key-1',
        { orderName: 2561 },
      ),
    ).resolves.toBe(response);
    expect(calls).toEqual(['restore:42:manager-id:3:order-restore-key-1:2561:request-restore-1']);
  });

  it('requires authenticated current user before restore transaction service', async () => {
    const controller = createController({
      flags: {
        ordersEnabled: true,
        ordersReadOnly: false,
      },
    });

    await expect(
      controller.restore({}, '42', '"3"', 'order-restore-key-1', {}),
    ).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
      statusCode: 401,
    } satisfies Partial<ApiError>);
  });

  it('blocks restore when orders API is read-only', async () => {
    const controller = createController({
      flags: {
        ordersEnabled: true,
        ordersReadOnly: true,
      },
    });

    await expect(
      controller.restore(
        { user: currentUser('manager-id') },
        '42',
        '"3"',
        'order-restore-key-1',
        {},
      ),
    ).rejects.toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      statusCode: 503,
      details: {
        feature: 'orders',
        mode: 'read_only',
      },
    } satisfies Partial<ApiError>);
  });

  it('rejects missing restore command headers as BAD_REQUEST', async () => {
    const controller = createController({
      flags: {
        ordersEnabled: true,
        ordersReadOnly: false,
      },
    });

    await expect(
      controller.restore(
        { user: currentUser('manager-id') },
        '42',
        undefined,
        'order-restore-key-1',
        {},
      ),
    ).rejects.toThrow(ApiError);

    await expect(
      controller.restore(
        { user: currentUser('manager-id') },
        '42',
        '"3"',
        undefined,
        {},
      ),
    ).rejects.toThrow(ApiError);
  });

  it('returns 422 for empty restore orderName after trim', async () => {
    const controller = createController({
      flags: {
        ordersEnabled: true,
        ordersReadOnly: false,
      },
      service: {
        async restore(command) {
          if ((command.orderName ?? '').trim() === '') {
            throw new ApiError(422, 'VALIDATION_ERROR', 'orderName не может быть пустым', {
              field: 'orderName',
            });
          }
          throw new Error('restore should not succeed');
        },
      },
    });

    await expect(
      controller.restore(
        { user: currentUser('manager-id') },
        '42',
        '"3"',
        'order-restore-key-1',
        { orderName: '   ' },
      ),
    ).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      statusCode: 422,
    } satisfies Partial<ApiError>);
  });

  it('rejects invalid path order ids as BAD_REQUEST', () => {
    expect(() => parseOrderId('0')).toThrow(ApiError);
    expect(() => parseOrderId('raw_sql')).toThrow(ApiError);
    expect(parseOrderId('42')).toBe(42);
  });
});

function createController(options: {
  flags: { ordersEnabled: boolean; ordersReadOnly: boolean };
  service?: Partial<OrderTransactionService>;
  queries?: Partial<OrderQueryService>;
  database?: ReturnType<typeof createDatabase>;
}): OrdersController {
  const service = {
    async create() {
      throw new Error('create should not be called');
    },
    async update() {
      throw new Error('update should not be called');
    },
    async delete() {
      throw new Error('delete should not be called');
    },
    async restore() {
      throw new Error('restore should not be called');
    },
    ...options.service,
  } as unknown as OrderTransactionService;
  const queries = {
    async list() {
      throw new Error('list should not be called');
    },
    async getById() {
      throw new Error('getById should not be called');
    },
    async getAudit() {
      throw new Error('getAudit should not be called');
    },
    async getFormData() {
      throw new Error('getFormData should not be called');
    },
    ...options.queries,
  } as unknown as OrderQueryService;
  const runtimeConfig = {
    getFeatureFlags() {
      return options.flags;
    },
  } as OrdersRuntimeConfigService;
  const database = (options.database?.service ?? {
    async query() {
      return { rows: [] };
    },
  }) as unknown as DatabaseService;

  return new OrdersController(service, queries, runtimeConfig, database);
}

function currentUser(
  id = 'user_manager',
  role: CurrentUser['role'] = 'manager',
): CurrentUser {
  return {
    id,
    username: role,
    role,
    roleId: role === 'viewer' ? 100 : role === 'top_manager' ? 15 : 10,
    permissions: getPermissionsForRole(role),
  };
}

function userWithExtraPermissions(
  id: string,
  role: CurrentUser['role'],
  extraPermissions: string[],
): CurrentUser {
  return {
    ...currentUser(id, role),
    permissions: [...new Set([...getPermissionsForRole(role), ...extraPermissions])],
  };
}

function createSaveOrderDto(): SaveOrderDto {
  return {
    header: {
      orderName: 'Test order',
      clientId: 1001,
      orderDate: '2026-04-30',
      orderStatusId: 1001,
      discount: 0,
      surcharge: 0,
    },
    details: [],
    payments: [],
    workshops: [],
    requirements: [],
    dowelingLinks: [],
    deleted: {},
  };
}

function createOrderDto(overrides: { orderId: number }): OrderDto {
  return {
    header: {
      orderId: overrides.orderId,
      orderName: 'Test order',
      clientId: 1001,
      orderDate: '2026-04-30',
      priority: 100,
      orderStatusId: 1001,
      paymentStatusId: 1,
      productionStatusId: null,
      productionStatusFromDetailsEnabled: true,
      plannedCompletionDate: null,
      completionDate: null,
      issueDate: null,
      paymentDate: null,
      totalAmount: 0,
      discount: 0,
      surcharge: 0,
      finalAmount: 0,
      paidAmount: 0,
      partsCount: 0,
      totalArea: 0,
      linkCuttingFile: null,
      linkCuttingImageFile: null,
      linkCadFile: null,
      linkPdfFile: null,
      notes: null,
      refKey1c: null,
      createdAt: '2026-04-30T00:00:00.000Z',
      updatedAt: '2026-04-30T00:00:00.000Z',
      version: 1,
    },
    details: [],
    payments: [],
    workshops: [],
    requirements: [],
    dowelingLinks: [],
    totals: {
      totalAmount: 0,
      finalAmount: 0,
      paidAmount: 0,
      debtAmount: 0,
      partsCount: 0,
      totalArea: 0,
    },
    version: 1,
    createdAt: '2026-04-30T00:00:00.000Z',
    updatedAt: '2026-04-30T00:00:00.000Z',
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
  };
}

function createDatabase() {
  const queries: Array<{ text: string; params: readonly unknown[] }> = [];
  const service = {
    async query(text: string, params: readonly unknown[] = []) {
      queries.push({ text, params });
      return { rows: [{ audit_id: 'audit-denied-1' }] };
    },
  } as unknown as DatabaseService;

  return { service, queries };
}
