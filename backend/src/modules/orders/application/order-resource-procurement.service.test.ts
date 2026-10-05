import { describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import { RESOURCE_PROCUREMENT_BULK_LIMIT } from './order-resource-demand.types';
import { OrderResourceDemandService } from './order-resource-demand.service';

function user(permissions: CurrentUser['permissions']): CurrentUser {
  return {
    id: '7',
    username: 'e2e-test-worker@example.test',
    role: 'viewer',
    roleId: 7,
    permissions,
  };
}

function fakeAuditClient() {
  const calls: Array<{ text: string; params: unknown[] }> = [];
  const query = vi.fn(async (text: string, params: unknown[] = []) => {
    calls.push({ text, params });
    return { rows: [{ audit_id: 'audit-1' }] };
  });
  return { query, calls } as unknown as { query: typeof query; calls: typeof calls };
}

describe('OrderResourceDemandService read gates', () => {
  it('requires orders.view before list()', async () => {
    const list = vi.fn();
    const service = new OrderResourceDemandService({ demands: { list, getCard: vi.fn(), listByMaterial: vi.fn() } });
    await expect(service.list({ currentUser: user([]), query: { page: 1, pageSize: 20 } }))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED', statusCode: 403 });
    expect(list).not.toHaveBeenCalled();
  });

  it('requires orders.view before getCard()', async () => {
    const getCard = vi.fn();
    const service = new OrderResourceDemandService({ demands: { list: vi.fn(), getCard, listByMaterial: vi.fn() } });
    await expect(service.getCard({ currentUser: user([]), orderId: 501 }, { procurementEnabled: false }))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED', statusCode: 403 });
    expect(getCard).not.toHaveBeenCalled();
  });

  it('requires orders.view before listByMaterial()', async () => {
    const listByMaterial = vi.fn();
    const service = new OrderResourceDemandService({ demands: { list: vi.fn(), getCard: vi.fn(), listByMaterial } });
    await expect(service.listByMaterial({ currentUser: user([]), query: { page: 1, pageSize: 20 } }, { procurementEnabled: false }))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED', statusCode: 403 });
    expect(listByMaterial).not.toHaveBeenCalled();
  });
});

describe('OrderResourceDemandService.setProcurement permission gate', () => {
  it('denies without procurement.manage, records a denied audit row, and never calls the procurement port', async () => {
    const set = vi.fn();
    const auditClient = fakeAuditClient();
    const service = new OrderResourceDemandService({
      demands: { list: vi.fn(), getCard: vi.fn(), listByMaterial: vi.fn() },
      procurement: { set, bulk: vi.fn() },
      auditClient: auditClient as never,
    });

    await expect(service.setProcurement({
      currentUser: user(['orders.view']),
      orderId: 501,
      resourceKey: 'sheet_material:11',
      purchased: true,
      expectedVersion: 0,
      expectedDemandFingerprint: 'a'.repeat(64),
      requestId: 'req-denied-1',
    })).rejects.toMatchObject({ code: 'PERMISSION_DENIED', statusCode: 403 });

    expect(set).not.toHaveBeenCalled();
    expect(auditClient.calls.length).toBeGreaterThan(0);
    const [firstCall] = auditClient.calls;
    expect(firstCall.text).toContain('INSERT INTO audit_log');
    expect(firstCall.params[0]).toBe('order_resource.procurement_denied');
  });

  it('a permission granted with only orders.view is not enough (literal procurement.manage check)', async () => {
    const set = vi.fn();
    const service = new OrderResourceDemandService({
      demands: { list: vi.fn(), getCard: vi.fn(), listByMaterial: vi.fn() },
      procurement: { set, bulk: vi.fn() },
    });
    await expect(service.setProcurement({
      currentUser: user(['orders.view', 'procurement.view']),
      orderId: 501,
      resourceKey: 'sheet_material:11',
      purchased: true,
      expectedVersion: 0,
      expectedDemandFingerprint: 'a'.repeat(64),
      requestId: 'req-denied-2',
    })).rejects.toMatchObject({ code: 'PERMISSION_DENIED', statusCode: 403 });
    expect(set).not.toHaveBeenCalled();
  });

  it('delegates a valid setProcurement call unchanged', async () => {
    const expected = { orderId: 501, resourceKey: 'sheet_material:11', changed: true, line: {} };
    const set = vi.fn().mockResolvedValue(expected);
    const service = new OrderResourceDemandService({
      demands: { list: vi.fn(), getCard: vi.fn(), listByMaterial: vi.fn() },
      procurement: { set, bulk: vi.fn() },
    });
    const command = {
      currentUser: user(['procurement.manage']),
      orderId: 501,
      resourceKey: 'sheet_material:11',
      purchased: true,
      expectedVersion: 0,
      expectedDemandFingerprint: 'a'.repeat(64),
      requestId: 'req-ok-1',
    };
    await expect(service.setProcurement(command)).resolves.toBe(expected);
    expect(set).toHaveBeenCalledWith(command);
  });
});

describe('OrderResourceDemandService.bulkProcurement permission gate and validation', () => {
  function bulkCommand(overrides: Partial<Parameters<OrderResourceDemandService['bulkProcurement']>[0]> = {}) {
    return {
      currentUser: user(['procurement.manage']),
      resourceKey: 'sheet_material:11',
      purchased: true,
      items: [{ orderId: 501, expectedVersion: 0, expectedDemandFingerprint: 'a'.repeat(64) }],
      requestId: 'req-bulk-1',
      ...overrides,
    };
  }

  it('denies without procurement.manage, records a denied audit row, and never calls the procurement port', async () => {
    const bulk = vi.fn();
    const auditClient = fakeAuditClient();
    const service = new OrderResourceDemandService({
      demands: { list: vi.fn(), getCard: vi.fn(), listByMaterial: vi.fn() },
      procurement: { set: vi.fn(), bulk },
      auditClient: auditClient as never,
    });

    await expect(service.bulkProcurement(bulkCommand({ currentUser: user(['orders.view']) })))
      .rejects.toMatchObject({ code: 'PERMISSION_DENIED', statusCode: 403 });

    expect(bulk).not.toHaveBeenCalled();
    const [firstCall] = auditClient.calls;
    expect(firstCall.text).toContain('INSERT INTO audit_log');
    expect(firstCall.params[0]).toBe('order_resource.procurement_denied');
  });

  it('rejects an empty item list before touching the port', async () => {
    const bulk = vi.fn();
    const service = new OrderResourceDemandService({
      demands: { list: vi.fn(), getCard: vi.fn(), listByMaterial: vi.fn() },
      procurement: { set: vi.fn(), bulk },
    });
    await expect(service.bulkProcurement(bulkCommand({ items: [] })))
      .rejects.toMatchObject({ code: 'PROCUREMENT_BULK_SIZE_INVALID', statusCode: 422 });
    expect(bulk).not.toHaveBeenCalled();
  });

  it('rejects more than the bulk limit', async () => {
    const bulk = vi.fn();
    const service = new OrderResourceDemandService({
      demands: { list: vi.fn(), getCard: vi.fn(), listByMaterial: vi.fn() },
      procurement: { set: vi.fn(), bulk },
    });
    const items = Array.from({ length: RESOURCE_PROCUREMENT_BULK_LIMIT + 1 }, (_, i) => ({
      orderId: i + 1,
      expectedVersion: 0,
      expectedDemandFingerprint: 'a'.repeat(64),
    }));
    await expect(service.bulkProcurement(bulkCommand({ items })))
      .rejects.toMatchObject({ code: 'PROCUREMENT_BULK_SIZE_INVALID', statusCode: 422 });
    expect(bulk).not.toHaveBeenCalled();
  });

  it('rejects duplicate orderIds in the same bulk request', async () => {
    const bulk = vi.fn();
    const service = new OrderResourceDemandService({
      demands: { list: vi.fn(), getCard: vi.fn(), listByMaterial: vi.fn() },
      procurement: { set: vi.fn(), bulk },
    });
    const items = [
      { orderId: 501, expectedVersion: 0, expectedDemandFingerprint: 'a'.repeat(64) },
      { orderId: 501, expectedVersion: 0, expectedDemandFingerprint: 'b'.repeat(64) },
    ];
    await expect(service.bulkProcurement(bulkCommand({ items })))
      .rejects.toMatchObject({ code: 'PROCUREMENT_BULK_DUPLICATE_ORDER', statusCode: 422 });
    expect(bulk).not.toHaveBeenCalled();
  });

  it('delegates a valid bulk call unchanged', async () => {
    const expected = { results: [] };
    const bulk = vi.fn().mockResolvedValue(expected);
    const service = new OrderResourceDemandService({
      demands: { list: vi.fn(), getCard: vi.fn(), listByMaterial: vi.fn() },
      procurement: { set: vi.fn(), bulk },
    });
    const command = bulkCommand();
    await expect(service.bulkProcurement(command)).resolves.toBe(expected);
    expect(bulk).toHaveBeenCalledWith(command);
  });
});
