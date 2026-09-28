import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import type { CurrentUser, RequestWithCurrentUser } from '../../../permissions/current-user';
import { parseOrderResourceDemandQuery } from './order-resource-demand.controller';
import { OrderResourceProcurementController } from './order-resource-procurement.controller';

vi.mock('@nestjs/common', () => ({
  Body: () => () => undefined,
  Controller: () => () => undefined,
  Get: () => () => undefined,
  Inject: () => () => undefined,
  Injectable: () => () => undefined,
  Optional: () => () => undefined,
  Param: () => () => undefined,
  Post: () => () => undefined,
  Put: () => () => undefined,
  Query: () => () => undefined,
  Req: () => () => undefined,
}));

vi.mock('@nestjs/swagger', () => ({
  ApiBearerAuth: () => () => undefined,
  ApiOperation: () => () => undefined,
  ApiQuery: () => () => undefined,
  ApiResponse: () => () => undefined,
  ApiTags: () => () => undefined,
}));

type ControllerCtorArgs = ConstructorParameters<typeof OrderResourceProcurementController>;

function currentUser(): CurrentUser {
  return { id: '9', username: 'e2e-test-snabzhenets', role: 'admin', roleId: 1, permissions: ['procurement.manage'] };
}

function request(user: CurrentUser | undefined, requestId = 'req-1'): RequestWithCurrentUser {
  return { user, requestId };
}

function flags(overrides: Partial<{
  ordersEnabled: boolean;
  ordersReadOnly: boolean;
  resourceProcurementEnabled: boolean;
}> = {}) {
  return {
    ordersEnabled: true,
    ordersReadOnly: false,
    resourceProcurementEnabled: true,
    ...overrides,
  };
}

function makeController(service: Partial<{ getCard: ReturnType<typeof vi.fn>; setProcurement: ReturnType<typeof vi.fn>; bulkProcurement: ReturnType<typeof vi.fn> }>, featureFlags: ReturnType<typeof flags>) {
  const runtimeConfig = { getFeatureFlags: () => featureFlags };
  return new OrderResourceProcurementController(
    service as unknown as ControllerCtorArgs[0],
    runtimeConfig as unknown as ControllerCtorArgs[1],
  );
}

const validFingerprint = 'a'.repeat(64);

describe('OrderResourceProcurementController.card', () => {
  it('allows reads with the procurement flag off and passes procurementEnabled:false', async () => {
    const getCard = vi.fn().mockResolvedValue({ data: {}, refreshedAt: '2026-09-27T00:00:00.000Z', capabilities: {} });
    const controller = makeController({ getCard }, flags({ resourceProcurementEnabled: false }));

    await controller.card(request(currentUser()), '501');

    expect(getCard).toHaveBeenCalledWith(
      { currentUser: currentUser(), orderId: 501 },
      // Суммы документов 1С — только с finance.view (у тестового пользователя его нет).
      { procurementEnabled: false, canSeeAmounts: currentUser().permissions.includes('finance.view') },
    );
  });

  it('rejects an invalid orderId', async () => {
    const controller = makeController({ getCard: vi.fn() }, flags());
    await expect(controller.card(request(currentUser()), '0')).rejects.toMatchObject({
      statusCode: 422,
      code: 'ORDER_ID_INVALID',
    });
    await expect(controller.card(request(currentUser()), 'abc')).rejects.toMatchObject({
      statusCode: 422,
      code: 'ORDER_ID_INVALID',
    });
  });

  it('rejects when ordersEnabled is off', async () => {
    const controller = makeController({ getCard: vi.fn() }, flags({ ordersEnabled: false }));
    await expect(controller.card(request(currentUser()), '501')).rejects.toMatchObject({
      statusCode: 503,
      code: 'SERVICE_UNAVAILABLE',
    });
  });
});

describe('OrderResourceProcurementController.set (PUT)', () => {
  const validBody = { purchased: true, expectedVersion: 0, expectedDemandFingerprint: validFingerprint };

  it('returns 503 PROCUREMENT_DISABLED when the procurement flag is off', async () => {
    const controller = makeController({ setProcurement: vi.fn() }, flags({ resourceProcurementEnabled: false }));
    await expect(controller.set(request(currentUser()), '501', 'sheet_material:11', validBody)).rejects.toMatchObject({
      statusCode: 503,
      code: 'PROCUREMENT_DISABLED',
    });
  });

  it('returns 503 when orders are read-only', async () => {
    const controller = makeController({ setProcurement: vi.fn() }, flags({ ordersReadOnly: true }));
    await expect(controller.set(request(currentUser()), '501', 'sheet_material:11', validBody)).rejects.toMatchObject({
      statusCode: 503,
    });
  });

  it('returns 401 without a user, even with every flag enabled', async () => {
    const controller = makeController({ setProcurement: vi.fn() }, flags());
    await expect(controller.set(request(undefined), '501', 'sheet_material:11', validBody)).rejects.toMatchObject({
      statusCode: 401,
      code: 'AUTH_REQUIRED',
    });
  });

  it('rejects an invalid orderId', async () => {
    const controller = makeController({ setProcurement: vi.fn() }, flags());
    await expect(controller.set(request(currentUser()), '0', 'sheet_material:11', validBody)).rejects.toMatchObject({
      statusCode: 422,
      code: 'ORDER_ID_INVALID',
    });
  });

  it.each([
    ['a non-hex-64 fingerprint', { ...validBody, expectedDemandFingerprint: 'not-a-hash' }],
    ['a negative expectedVersion', { ...validBody, expectedVersion: -1 }],
    ['an extra unknown key', { ...validBody, extra: true }],
  ])('rejects %s with 422 PROCUREMENT_INVALID_INPUT', async (_label, body) => {
    const controller = makeController({ setProcurement: vi.fn() }, flags());
    await expect(controller.set(request(currentUser()), '501', 'sheet_material:11', body)).rejects.toMatchObject({
      statusCode: 422,
      code: 'PROCUREMENT_INVALID_INPUT',
    });
  });

  it('forwards the requestId from the request', async () => {
    const setProcurement = vi.fn().mockResolvedValue({ orderId: 501, resourceKey: 'sheet_material:11', changed: true, line: {} });
    const controller = makeController({ setProcurement }, flags());
    await controller.set(request(currentUser(), 'req-xyz-123'), '501', 'sheet_material:11', validBody);
    expect(setProcurement).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'req-xyz-123', orderId: 501, resourceKey: 'sheet_material:11' }));
  });
});

describe('OrderResourceProcurementController.bulk (POST)', () => {
  const validBulkBody = {
    resourceKey: 'sheet_material:11',
    purchased: true,
    items: [{ orderId: 501, expectedVersion: 0, expectedDemandFingerprint: validFingerprint }],
  };

  it('returns 503 PROCUREMENT_DISABLED when the procurement flag is off', async () => {
    const controller = makeController({ bulkProcurement: vi.fn() }, flags({ resourceProcurementEnabled: false }));
    await expect(controller.bulk(request(currentUser()), validBulkBody)).rejects.toMatchObject({
      statusCode: 503,
      code: 'PROCUREMENT_DISABLED',
    });
  });

  it('returns 503 when orders are read-only', async () => {
    const controller = makeController({ bulkProcurement: vi.fn() }, flags({ ordersReadOnly: true }));
    await expect(controller.bulk(request(currentUser()), validBulkBody)).rejects.toMatchObject({ statusCode: 503 });
  });

  it('returns 401 without a user', async () => {
    const controller = makeController({ bulkProcurement: vi.fn() }, flags());
    await expect(controller.bulk(request(undefined), validBulkBody)).rejects.toMatchObject({
      statusCode: 401,
      code: 'AUTH_REQUIRED',
    });
  });

  it('rejects more than 100 bulk items with 422 PROCUREMENT_INVALID_INPUT', async () => {
    const controller = makeController({ bulkProcurement: vi.fn() }, flags());
    const items = Array.from({ length: 101 }, (_, i) => ({ orderId: i + 1, expectedVersion: 0, expectedDemandFingerprint: validFingerprint }));
    await expect(controller.bulk(request(currentUser()), { ...validBulkBody, items })).rejects.toMatchObject({
      statusCode: 422,
      code: 'PROCUREMENT_INVALID_INPUT',
    });
  });

  it('forwards the requestId from the request', async () => {
    const bulkProcurement = vi.fn().mockResolvedValue({ results: [] });
    const controller = makeController({ bulkProcurement }, flags());
    await controller.bulk(request(currentUser(), 'req-bulk-999'), validBulkBody);
    expect(bulkProcurement).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'req-bulk-999' }));
  });
});

describe('parseOrderResourceDemandQuery unpurchasedOnly', () => {
  it('parses the string "true" to boolean true', () => {
    expect(parseOrderResourceDemandQuery({ unpurchasedOnly: 'true' })).toMatchObject({ unpurchasedOnly: true });
  });

  it('omits the key for "false"', () => {
    const result = parseOrderResourceDemandQuery({ unpurchasedOnly: 'false' });
    expect(result).not.toHaveProperty('unpurchasedOnly');
  });

  it('omits the key when absent', () => {
    const result = parseOrderResourceDemandQuery({});
    expect(result).not.toHaveProperty('unpurchasedOnly');
  });

  it('rejects any other value with 422', () => {
    expect(() => parseOrderResourceDemandQuery({ unpurchasedOnly: 'yes' })).toThrow(ApiError);
    try {
      parseOrderResourceDemandQuery({ unpurchasedOnly: 'yes' });
    } catch (error) {
      expect(error).toMatchObject({ statusCode: 422, details: { field: 'unpurchasedOnly' } });
    }
  });
});

describe('parseOrderResourceDemandQuery — onecDocumentId filter', () => {
  it('accepts a positive document id and rejects invalid ones', async () => {
    const { parseOrderResourceDemandQuery } = await import('./order-resource-demand.controller');
    expect(parseOrderResourceDemandQuery({ onecDocumentId: '42' })).toMatchObject({ onecDocumentId: 42 });
    expect(parseOrderResourceDemandQuery({})).not.toHaveProperty('onecDocumentId');
    for (const bad of ['0', '-1', 'abc', '1.5']) {
      expect(() => parseOrderResourceDemandQuery({ onecDocumentId: bad })).toThrow();
    }
  });
});
