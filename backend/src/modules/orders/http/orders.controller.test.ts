import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser } from '../../../permissions/current-user';
import { getPermissionsForRole } from '../../../permissions/permissions';
import type { OrderQueryService } from '../application/order-query.service';
import type { OrderTransactionService } from '../application/order-transaction.service';
import type { OrderDto, OrderListResponseDto } from '../dto/order.dto';
import type { SaveOrderDto } from '../dto/save-order.dto';
import { OrdersController, parseOrderId, parseOrderListQuery } from './orders.controller';
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

  it('normalizes list query with whitelist defaults', () => {
    expect(
      parseOrderListQuery({
        page: '2',
        pageSize: '50',
        sortBy: 'orderDate',
        sortOrder: 'asc',
        search: '  Order A ',
        clientId: '12',
        orderStatusId: '3',
        paymentStatusId: '4',
        productionStatusId: '5',
        dateFrom: '2026-04-01',
        dateTo: '2026-04-30',
        onlyMyOrders: 'true',
      }),
    ).toEqual({
      page: 2,
      pageSize: 50,
      sortBy: 'orderDate',
      sortOrder: 'asc',
      search: 'Order A',
      clientId: 12,
      orderStatusId: 3,
      paymentStatusId: 4,
      productionStatusId: 5,
      dateFrom: '2026-04-01',
      dateTo: '2026-04-30',
      onlyMyOrders: true,
    });
  });

  it('rejects unsupported sort fields as validation errors', () => {
    expect(() => parseOrderListQuery({ sortBy: 'raw_sql_injection' })).toThrow(ApiError);
    expect(() => parseOrderListQuery({ pageSize: '201' })).toThrow(ApiError);
    expect(() => parseOrderListQuery({ dateFrom: '30.04.2026' })).toThrow(ApiError);
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
}): OrdersController {
  const service = {
    async create() {
      throw new Error('create should not be called');
    },
    async update() {
      throw new Error('update should not be called');
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
    ...options.queries,
  } as unknown as OrderQueryService;
  const runtimeConfig = {
    getFeatureFlags() {
      return options.flags;
    },
  } as OrdersRuntimeConfigService;

  return new OrdersController(service, queries, runtimeConfig);
}

function currentUser(id = 'user_manager'): CurrentUser {
  return {
    id,
    username: 'manager',
    role: 'manager',
    roleId: 10,
    permissions: getPermissionsForRole('manager'),
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
