import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { SupplierRequestsService } from '../application/supplier-requests.service';
import { draftsSchema, listQuerySchema, SupplierRequestsController, transitionSchema, updateSchema } from './supplier-requests.controller';

const uuid = '11111111-1111-4111-8111-111111111111';

describe('supplier requests input validation', () => {
  it('list query: statuses deduplicated, search trimmed', () => {
    expect(listQuerySchema.parse({ status: 'draft,sent,draft', search: '  26-00 ' })).toEqual({ status: ['draft', 'sent'], search: '26-00' });
    expect(listQuerySchema.safeParse({ status: 'draft,lost' }).success).toBe(false);
    expect(listQuerySchema.safeParse({ extra: '1' }).success).toBe(false);
  });

  it('drafts: requestId UUID, 1..200 items with a valid material key', () => {
    const item = { orderId: 5, resourceKey: 'sheet_material:8' };
    expect(draftsSchema.safeParse({ requestId: uuid, items: [item, { orderId: 6, resourceKey: 'film:12' }] }).success).toBe(true);
    expect(draftsSchema.safeParse({ requestId: 'x', items: [item] }).success).toBe(false);
    expect(draftsSchema.safeParse({ requestId: uuid, items: [] }).success).toBe(false);
    expect(draftsSchema.safeParse({ requestId: uuid, items: Array.from({ length: 201 }, (_, index) => ({ orderId: index + 1, resourceKey: 'film:1' })) }).success).toBe(false);
    expect(draftsSchema.safeParse({ requestId: uuid, items: [{ orderId: 5, resourceKey: 'hdf:1' }] }).success).toBe(false);
    expect(draftsSchema.safeParse({ requestId: uuid, items: [{ ...item, quantity: 3 }] }).success).toBe(false);
  });

  it('update: version required, quantities > 0 with ≤ 3 decimals, dates checked', () => {
    expect(updateSchema.safeParse({ expectedVersion: 0, comment: null, expectedDate: '2026-10-05', supplierId: null }).success).toBe(true);
    expect(updateSchema.safeParse({ expectedVersion: 1, lines: [{ lineId: 1, quantity: 3, orders: [{ lineOrderId: 2, quantity: 1.726 }] }] }).success).toBe(true);
    expect(updateSchema.safeParse({ comment: 'x' }).success).toBe(false);
    expect(updateSchema.safeParse({ expectedVersion: 0, expectedDate: '2026-02-30' }).success).toBe(false);
    expect(updateSchema.safeParse({ expectedVersion: 0, lines: [{ lineId: 1, quantity: 0, orders: [] }] }).success).toBe(false);
    expect(updateSchema.safeParse({ expectedVersion: 0, lines: [{ lineId: 1, quantity: 1.0001, orders: [] }] }).success).toBe(false);
    expect(updateSchema.safeParse({ expectedVersion: 0, status: 'sent' }).success).toBe(false);
    expect(transitionSchema.safeParse({ expectedVersion: 3 }).success).toBe(true);
    expect(transitionSchema.safeParse({}).success).toBe(false);
  });
});

describe('SupplierRequestsController flags', () => {
  const flags = (overrides: Record<string, boolean> = {}) => ({
    getFeatureFlags: () => ({
      ordersEnabled: true, ordersReadOnly: false, resourceProcurementEnabled: true, procurementWorkspaceEnabled: true,
      supplierRequestsEnabled: true, ...overrides,
    }),
  });
  const request = { user: { id: '1', username: 'u', role: 'admin', roleId: 1, permissions: ['procurement.view'] }, requestId: 'r' };

  it('503 SUPPLIER_REQUESTS_DISABLED without the flag (and without the workspace/procurement flags)', async () => {
    for (const off of ['supplierRequestsEnabled', 'procurementWorkspaceEnabled', 'resourceProcurementEnabled']) {
      const service = { list: vi.fn() } as unknown as SupplierRequestsService;
      const controller = new SupplierRequestsController(service, flags({ [off]: false }) as never);
      await expect(controller.list(request as never, {})).rejects.toMatchObject({ statusCode: 503, code: 'SUPPLIER_REQUESTS_DISABLED' });
      expect(service.list).not.toHaveBeenCalled();
    }
  });

  it('writes are refused while orders are read-only', async () => {
    const service = { transition: vi.fn() } as unknown as SupplierRequestsService;
    const controller = new SupplierRequestsController(service, flags({ ordersReadOnly: true }) as never);
    await expect(controller.send(request as never, '5', { expectedVersion: 0 })).rejects.toMatchObject({ statusCode: 503 });
    expect(service.transition).not.toHaveBeenCalled();
  });

  it('POST commands answer 200 (no-op and idempotent repeat included), as in the contract (CR1-5)', () => {
    for (const method of ['createDrafts', 'send', 'close', 'cancel'] as const) {
      expect(Reflect.getMetadata('__httpCode__', SupplierRequestsController.prototype[method])).toBe(200);
    }
  });

  it('passes the transition and the audit request id through', async () => {
    const transition = vi.fn().mockResolvedValue({ changed: true });
    const controller = new SupplierRequestsController({ transition } as unknown as SupplierRequestsService, flags() as never);
    await controller.cancel(request as never, '7', { expectedVersion: 2 });
    expect(transition).toHaveBeenCalledWith(expect.objectContaining({ supplierRequestId: 7, expectedVersion: 2, transition: 'cancel', requestId: 'r' }));
    await expect(controller.cancel(request as never, '0', { expectedVersion: 2 })).rejects.toMatchObject({ statusCode: 422 });
  });
});

describe('SupplierRequestsService permissions (literal)', () => {
  const repository = {
    createDrafts: vi.fn(), list: vi.fn(), getCard: vi.fn(), update: vi.fn(), transition: vi.fn(),
  };
  const user = (permissions: string[]) => ({ id: '5', username: 'u', role: 'manager', roleId: 10, permissions });

  it('CR1-4: a command without both permissions is refused with a denied audit listing both', async () => {
    const auditClient = { query: vi.fn().mockResolvedValue({ rows: [{ audit_id: '1' }], rowCount: 1 }) };
    const service = new SupplierRequestsService({ repository, auditClient: auditClient as never });
    await expect(service.transition({ currentUser: user(['orders.view']), requestId: uuid, supplierRequestId: 4, expectedVersion: 0, transition: 'send' }))
      .rejects.toMatchObject({ statusCode: 403, details: { requiredPermissions: ['procurement.view', 'procurement.manage'] } });
    expect(auditClient.query).toHaveBeenCalled();
    expect(JSON.stringify(auditClient.query.mock.calls[0][1])).toContain('procurement.supplier_request_denied');
    expect(repository.transition).not.toHaveBeenCalled();
  });

  it('read needs procurement.view; commands need procurement.manage (denied audit written)', async () => {
    const auditClient = { query: vi.fn().mockResolvedValue({ rows: [{ audit_id: '1' }], rowCount: 1 }) };
    const service = new SupplierRequestsService({ repository, auditClient: auditClient as never });
    await expect(service.list(user(['orders.view']), {})).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.createDrafts({ currentUser: user(['procurement.view']), requestId: uuid, items: [] }))
      .rejects.toMatchObject({ statusCode: 403 });
    expect(auditClient.query).toHaveBeenCalled();
    expect(repository.createDrafts).not.toHaveBeenCalled();
    await service.getCard(user(['procurement.view']), 3);
    expect(repository.getCard).toHaveBeenCalledWith(expect.anything(), 3, false);
    await service.getCard(user(['procurement.view', 'procurement.manage']), 3);
    expect(repository.getCard).toHaveBeenLastCalledWith(expect.anything(), 3, true);
  });
});
