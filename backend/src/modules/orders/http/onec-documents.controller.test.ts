import { describe, expect, it, vi } from 'vitest';
import type { CurrentUser, RequestWithCurrentUser } from '../../../permissions/current-user';
import { OnecDocumentsController } from './onec-documents.controller';

vi.mock('@nestjs/common', () => ({
  Body: () => () => undefined,
  Controller: () => () => undefined,
  Delete: () => () => undefined,
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

type ControllerCtorArgs = ConstructorParameters<typeof OnecDocumentsController>;

function currentUser(): CurrentUser {
  return { id: '9', username: 'e2e-test-snabzhenets', role: 'admin', roleId: 1, permissions: ['procurement.view', 'procurement.manage'] };
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

function makeController(
  service: Partial<{ list: ReturnType<typeof vi.fn>; getCard: ReturnType<typeof vi.fn>; addAllocation: ReturnType<typeof vi.fn>; removeAllocation: ReturnType<typeof vi.fn> }>,
  featureFlags: ReturnType<typeof flags>,
) {
  const runtimeConfig = { getFeatureFlags: () => featureFlags };
  return new OnecDocumentsController(
    service as unknown as ControllerCtorArgs[0],
    runtimeConfig as unknown as ControllerCtorArgs[1],
  );
}

const validFingerprint = 'a'.repeat(64);

// --- flags: ordersEnabled / resourceProcurementEnabled / ordersReadOnly / auth --

describe('OnecDocumentsController — feature flags and auth', () => {
  it('list(): 503 SERVICE_UNAVAILABLE when ordersEnabled is off', async () => {
    const controller = makeController({ list: vi.fn() }, flags({ ordersEnabled: false }));
    await expect(controller.list(request(currentUser()), {})).rejects.toMatchObject({ statusCode: 503, code: 'SERVICE_UNAVAILABLE' });
  });

  it('list(): 503 PROCUREMENT_DISABLED when resourceProcurementEnabled is not true', async () => {
    const controller = makeController({ list: vi.fn() }, flags({ resourceProcurementEnabled: false }));
    await expect(controller.list(request(currentUser()), {})).rejects.toMatchObject({ statusCode: 503, code: 'PROCUREMENT_DISABLED' });
  });

  it('card(): 503 PROCUREMENT_DISABLED when resourceProcurementEnabled is not true', async () => {
    const controller = makeController({ getCard: vi.fn() }, flags({ resourceProcurementEnabled: false }));
    await expect(controller.card(request(currentUser()), '701')).rejects.toMatchObject({ statusCode: 503, code: 'PROCUREMENT_DISABLED' });
  });

  it('add(): 503 PROCUREMENT_DISABLED when resourceProcurementEnabled is not true', async () => {
    const controller = makeController({ addAllocation: vi.fn() }, flags({ resourceProcurementEnabled: false }));
    const body = { orderId: 501, resourceKey: 'sheet_material:11', quantity: 3, expectedVersion: 0, expectedDemandFingerprint: validFingerprint };
    await expect(controller.add(request(currentUser()), '701', '1', body)).rejects.toMatchObject({ statusCode: 503, code: 'PROCUREMENT_DISABLED' });
  });

  it('remove(): 503 PROCUREMENT_DISABLED when resourceProcurementEnabled is not true', async () => {
    const controller = makeController({ removeAllocation: vi.fn() }, flags({ resourceProcurementEnabled: false }));
    await expect(controller.remove(request(currentUser()), '701', '1', '9', { expectedVersion: 0 })).rejects.toMatchObject({ statusCode: 503, code: 'PROCUREMENT_DISABLED' });
  });

  it('add(): 503 SERVICE_UNAVAILABLE when orders are read-only', async () => {
    const controller = makeController({ addAllocation: vi.fn() }, flags({ ordersReadOnly: true }));
    const body = { orderId: 501, resourceKey: 'sheet_material:11', quantity: 3, expectedVersion: 0, expectedDemandFingerprint: validFingerprint };
    await expect(controller.add(request(currentUser()), '701', '1', body)).rejects.toMatchObject({ statusCode: 503 });
  });

  it('remove(): 503 SERVICE_UNAVAILABLE when orders are read-only', async () => {
    const controller = makeController({ removeAllocation: vi.fn() }, flags({ ordersReadOnly: true }));
    await expect(controller.remove(request(currentUser()), '701', '1', '9', { expectedVersion: 0 })).rejects.toMatchObject({ statusCode: 503 });
  });

  it('list(): reads are unaffected by ordersReadOnly', async () => {
    const list = vi.fn().mockResolvedValue({ data: [] });
    const controller = makeController({ list }, flags({ ordersReadOnly: true }));
    await expect(controller.list(request(currentUser()), {})).resolves.toBeDefined();
  });

  it('list(): 401 AUTH_REQUIRED without a user, even with every flag enabled', async () => {
    const controller = makeController({ list: vi.fn() }, flags());
    await expect(controller.list(request(undefined), {})).rejects.toMatchObject({ statusCode: 401, code: 'AUTH_REQUIRED' });
  });

  it('add(): 401 AUTH_REQUIRED without a user', async () => {
    const controller = makeController({ addAllocation: vi.fn() }, flags());
    const body = { orderId: 501, resourceKey: 'sheet_material:11', quantity: 3, expectedVersion: 0, expectedDemandFingerprint: validFingerprint };
    await expect(controller.add(request(undefined), '701', '1', body)).rejects.toMatchObject({ statusCode: 401, code: 'AUTH_REQUIRED' });
  });
});

// --- list(): query parsing -------------------------------------------------

describe('OnecDocumentsController.list — query parsing', () => {
  it('defaults tab=receipts, page=1, pageSize=20', async () => {
    const list = vi.fn().mockResolvedValue({ data: [] });
    const controller = makeController({ list }, flags());
    await controller.list(request(currentUser()), {});
    expect(list).toHaveBeenCalledWith(
      currentUser(),
      expect.objectContaining({ tab: 'receipts', page: 1, pageSize: 20 }),
      true,
    );
  });

  it('rejects pageSize over 100 with 422 ONEC_DOCUMENTS_QUERY_INVALID', async () => {
    const controller = makeController({ list: vi.fn() }, flags());
    await expect(controller.list(request(currentUser()), { pageSize: '101' }))
      .rejects.toMatchObject({ statusCode: 422, code: 'ONEC_DOCUMENTS_QUERY_INVALID' });
  });

  it('rejects an invalid tab with 422 ONEC_DOCUMENTS_QUERY_INVALID', async () => {
    const controller = makeController({ list: vi.fn() }, flags());
    await expect(controller.list(request(currentUser()), { tab: 'refunds' }))
      .rejects.toMatchObject({ statusCode: 422, code: 'ONEC_DOCUMENTS_QUERY_INVALID' });
  });

  it('rejects dateFrom after dateTo with 422 ONEC_DOCUMENTS_QUERY_INVALID', async () => {
    const controller = makeController({ list: vi.fn() }, flags());
    await expect(controller.list(request(currentUser()), { dateFrom: '2026-09-20', dateTo: '2026-09-01' }))
      .rejects.toMatchObject({ statusCode: 422, code: 'ONEC_DOCUMENTS_QUERY_INVALID' });
  });

  it('parses unlinkedOnly/postedOnly "true" strings to boolean true', async () => {
    const list = vi.fn().mockResolvedValue({ data: [] });
    const controller = makeController({ list }, flags());
    await controller.list(request(currentUser()), { unlinkedOnly: 'true', postedOnly: 'true' });
    expect(list).toHaveBeenCalledWith(
      currentUser(),
      expect.objectContaining({ unlinkedOnly: true, postedOnly: true }),
      true,
    );
  });

  it('parses unlinkedOnly/postedOnly "false" strings to boolean false', async () => {
    const list = vi.fn().mockResolvedValue({ data: [] });
    const controller = makeController({ list }, flags());
    await controller.list(request(currentUser()), { unlinkedOnly: 'false', postedOnly: 'false' });
    expect(list).toHaveBeenCalledWith(
      currentUser(),
      expect.objectContaining({ unlinkedOnly: false, postedOnly: false }),
      true,
    );
  });

  it('rejects an unparseable flag value with 422', async () => {
    const controller = makeController({ list: vi.fn() }, flags());
    await expect(controller.list(request(currentUser()), { unlinkedOnly: 'yes' }))
      .rejects.toMatchObject({ statusCode: 422, code: 'ONEC_DOCUMENTS_QUERY_INVALID' });
  });
});

// --- card(): id validation ---------------------------------------------

describe('OnecDocumentsController.card — id validation', () => {
  it('rejects a non-numeric documentId with 422 ONEC_ID_INVALID', async () => {
    const controller = makeController({ getCard: vi.fn() }, flags());
    await expect(controller.card(request(currentUser()), 'abc')).rejects.toMatchObject({ statusCode: 422, code: 'ONEC_ID_INVALID' });
  });

  it('rejects documentId "0" with 422 ONEC_ID_INVALID', async () => {
    const controller = makeController({ getCard: vi.fn() }, flags());
    await expect(controller.card(request(currentUser()), '0')).rejects.toMatchObject({ statusCode: 422, code: 'ONEC_ID_INVALID' });
  });

  it('delegates a valid card() call and forwards procurementEnabled:true', async () => {
    const expected = { data: {} };
    const getCard = vi.fn().mockResolvedValue(expected);
    const controller = makeController({ getCard }, flags());
    await expect(controller.card(request(currentUser()), '701')).resolves.toBe(expected);
    expect(getCard).toHaveBeenCalledWith(currentUser(), 701, true, false);
  });
});

// --- add(): body validation + id validation + requestId --------------------

describe('OnecDocumentsController.add — body and id validation', () => {
  const validBody = { orderId: 501, resourceKey: 'sheet_material:11', quantity: 3, expectedVersion: 0, expectedDemandFingerprint: validFingerprint };

  it.each([
    ['a non-hex-64 fingerprint', { ...validBody, expectedDemandFingerprint: 'not-a-hash' }],
    ['a negative quantity', { ...validBody, quantity: -1 }],
    ['a zero quantity', { ...validBody, quantity: 0 }],
    ['an extra unknown key', { ...validBody, extra: true }],
  ])('rejects %s with 422 ONEC_ALLOCATION_INVALID_INPUT', async (_label, body) => {
    const controller = makeController({ addAllocation: vi.fn() }, flags());
    await expect(controller.add(request(currentUser()), '701', '1', body))
      .rejects.toMatchObject({ statusCode: 422, code: 'ONEC_ALLOCATION_INVALID_INPUT' });
  });

  it('rejects an invalid documentId with 422 ONEC_ID_INVALID', async () => {
    const controller = makeController({ addAllocation: vi.fn() }, flags());
    await expect(controller.add(request(currentUser()), 'abc', '1', validBody))
      .rejects.toMatchObject({ statusCode: 422, code: 'ONEC_ID_INVALID' });
  });

  it('rejects an invalid lineId with 422 ONEC_ID_INVALID', async () => {
    const controller = makeController({ addAllocation: vi.fn() }, flags());
    await expect(controller.add(request(currentUser()), '701', '0', validBody))
      .rejects.toMatchObject({ statusCode: 422, code: 'ONEC_ID_INVALID' });
  });

  it('forwards the requestId and parsed ids to the service', async () => {
    const expected = { changed: true, allocationId: 1, orderId: 501, resourceKey: 'sheet_material:11', line: {} };
    const addAllocation = vi.fn().mockResolvedValue(expected);
    const controller = makeController({ addAllocation }, flags());
    await controller.add(request(currentUser(), 'req-add-xyz'), '701', '1', validBody);
    expect(addAllocation).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'req-add-xyz',
      documentId: 701,
      lineId: 1,
      orderId: 501,
      resourceKey: 'sheet_material:11',
      quantity: 3,
    }));
  });

  it('falls back to "unknown" requestId when the request carries none', async () => {
    const addAllocation = vi.fn().mockResolvedValue({});
    const controller = makeController({ addAllocation }, flags());
    await controller.add({ user: currentUser(), requestId: undefined }, '701', '1', validBody);
    expect(addAllocation).toHaveBeenCalledWith(expect.objectContaining({ requestId: 'unknown' }));
  });
});

// --- remove(): body validation + id validation + requestId -----------------

describe('OnecDocumentsController.remove — body and id validation', () => {
  const validBody = { expectedVersion: 0 };

  it.each([
    ['a negative expectedVersion', { expectedVersion: -1 }],
    ['an extra unknown key', { ...validBody, extra: true }],
  ])('rejects %s with 422 ONEC_ALLOCATION_INVALID_INPUT', async (_label, body) => {
    const controller = makeController({ removeAllocation: vi.fn() }, flags());
    await expect(controller.remove(request(currentUser()), '701', '1', '9', body))
      .rejects.toMatchObject({ statusCode: 422, code: 'ONEC_ALLOCATION_INVALID_INPUT' });
  });

  it('rejects an invalid allocationId with 422 ONEC_ID_INVALID', async () => {
    const controller = makeController({ removeAllocation: vi.fn() }, flags());
    await expect(controller.remove(request(currentUser()), '701', '1', 'abc', validBody))
      .rejects.toMatchObject({ statusCode: 422, code: 'ONEC_ID_INVALID' });
  });

  it('forwards the requestId and parsed ids to the service', async () => {
    const expected = { changed: true, allocationId: 9, orderId: 501, resourceKey: 'sheet_material:11', line: {} };
    const removeAllocation = vi.fn().mockResolvedValue(expected);
    const controller = makeController({ removeAllocation }, flags());
    await controller.remove(request(currentUser(), 'req-remove-xyz'), '701', '1', '9', validBody);
    expect(removeAllocation).toHaveBeenCalledWith(expect.objectContaining({
      requestId: 'req-remove-xyz',
      documentId: 701,
      lineId: 1,
      allocationId: 9,
      expectedVersion: 0,
    }));
  });
});

describe('OnecDocumentsController — measure precision matches the database (R1)', () => {
  const body = (extra: Record<string, unknown>) => ({
    orderId: 5, resourceKey: 'sheet_material:1', expectedVersion: 0, expectedDemandFingerprint: validFingerprint, ...extra,
  });
  it.each([
    [{ quantity: 1.2345 }],
    [{ amount: 10.005 }],
    [{ amount: 10.050000001 }],
    [{ amount: 1e-10 }],
    [{ quantity: 0.0001 }],
  ])('rejects extra decimal places %o instead of rounding silently', async (extra) => {
    const addAllocation = vi.fn();
    const controller = makeController({ addAllocation }, flags({}));
    await expect(controller.add(request(currentUser()), '1', '2', body(extra)))
      .rejects.toMatchObject({ statusCode: 422, code: 'ONEC_ALLOCATION_INVALID_INPUT' });
    expect(addAllocation).not.toHaveBeenCalled();
  });
  it.each([
    [{ quantity: 1.234 }],
    [{ amount: 10.05 }],
  ])('accepts database precision %o', async (extra) => {
    const addAllocation = vi.fn().mockResolvedValue({ changed: true });
    const controller = makeController({ addAllocation }, flags({}));
    await controller.add(request(currentUser()), '1', '2', body(extra));
    expect(addAllocation).toHaveBeenCalledWith(expect.objectContaining(extra));
  });
});
