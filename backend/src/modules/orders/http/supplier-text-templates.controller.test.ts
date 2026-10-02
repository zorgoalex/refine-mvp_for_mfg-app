import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { SupplierTextTemplatesService } from '../application/supplier-text-templates.service';
import { createTemplateSchema, SupplierTextTemplatesController, updateTemplateSchema, versionSchema } from './supplier-text-templates.controller';
import { SupplierRequestsController } from './supplier-requests.controller';
import type { SupplierRequestsService } from '../application/supplier-requests.service';

const uuid = '11111111-1111-4111-8111-111111111111';
const flags = (overrides: Record<string, boolean> = {}) => ({
  getFeatureFlags: () => ({
    ordersEnabled: true, ordersReadOnly: false, resourceProcurementEnabled: true, procurementWorkspaceEnabled: true,
    supplierRequestsEnabled: true, supplierTextTemplatesEnabled: true, ...overrides,
  }),
});
const user = { id: '1', username: 'u', role: 'admin', roleId: 1, permissions: ['procurement.view', 'procurement.manage'] };
const request = { user, requestId: 'r-1' };

describe('supplier text templates input', () => {
  it('commandKey UUID and version are required; unknown keys rejected', () => {
    expect(createTemplateSchema.safeParse({ commandKey: uuid, name: 'A', body: '{номер}', lineTemplate: '{материал}' }).success).toBe(true);
    expect(createTemplateSchema.safeParse({ commandKey: 'x', name: 'A', body: '{номер}', lineTemplate: '{материал}' }).success).toBe(false);
    expect(createTemplateSchema.safeParse({ commandKey: uuid, name: 'A', body: '{номер}', lineTemplate: '{материал}', isDefault: true }).success).toBe(false);
    expect(updateTemplateSchema.safeParse({ commandKey: uuid, expectedVersion: 1, body: 'x' }).success).toBe(true);
    expect(updateTemplateSchema.safeParse({ commandKey: uuid, body: 'x' }).success).toBe(false);
    expect(versionSchema.safeParse({ commandKey: uuid, expectedVersion: 0 }).success).toBe(false);
  });
});

describe('SupplierTextTemplatesController', () => {
  it('503 SUPPLIER_TEXT_TEMPLATES_DISABLED when its flag or any parent flag is off', async () => {
    for (const off of ['supplierTextTemplatesEnabled', 'supplierRequestsEnabled', 'procurementWorkspaceEnabled', 'resourceProcurementEnabled']) {
      const service = { list: vi.fn() } as unknown as SupplierTextTemplatesService;
      const controller = new SupplierTextTemplatesController(service, flags({ [off]: false }) as never);
      await expect(controller.list(request as never)).rejects.toMatchObject({ statusCode: 503, code: 'SUPPLIER_TEXT_TEMPLATES_DISABLED' });
      expect(service.list).not.toHaveBeenCalled();
    }
  });

  it('writes refused in read-only mode; commands pass commandKey, version, id and requestId', async () => {
    const readOnly = new SupplierTextTemplatesController({ create: vi.fn() } as never, flags({ ordersReadOnly: true }) as never);
    await expect(readOnly.create(request as never, {})).rejects.toMatchObject({ statusCode: 503 });
    const service = { setDefault: vi.fn().mockResolvedValue({}), remove: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}) };
    const controller = new SupplierTextTemplatesController(service as never, flags() as never);
    await controller.setDefault(request as never, '7', { commandKey: uuid, expectedVersion: 3 });
    expect(service.setDefault).toHaveBeenCalledWith({ commandKey: uuid, expectedVersion: 3, templateId: 7, currentUser: user, requestId: 'r-1' });
    await expect(controller.remove(request as never, '0', { commandKey: uuid, expectedVersion: 1 })).rejects.toMatchObject({ statusCode: 422 });
    await expect(controller.update(request as never, '7', { commandKey: uuid })).rejects.toMatchObject({ statusCode: 422 });
    expect(service.update).not.toHaveBeenCalled();
  });

  it('request card GET reports capabilities.supplierTextTemplates from the flag', async () => {
    for (const enabled of [true, false]) {
      const service = { getCard: vi.fn().mockResolvedValue({ supplierRequestId: 5 }) } as unknown as SupplierRequestsService;
      const controller = new SupplierRequestsController(service, flags({ supplierTextTemplatesEnabled: enabled }) as never);
      expect(await controller.card(request as never, '5')).toMatchObject({ capabilities: { supplierTextTemplates: enabled } });
    }
  });
});

describe('SupplierTextTemplatesService permissions', () => {
  const repository = { list: vi.fn().mockResolvedValue([]), create: vi.fn(), update: vi.fn(), remove: vi.fn(), setDefault: vi.fn() };
  const auditClient = { query: vi.fn().mockResolvedValue({ rows: [{ audit_id: 'a1' }], rowCount: 1 }) };
  const permissions = (granted: string[]) => ({ canUser: (_: unknown, permission: string) => granted.includes(permission) });

  it('list needs procurement.view; canManage is literal procurement.manage', async () => {
    const viewer = new SupplierTextTemplatesService({ repository, permissions: permissions(['procurement.view']) as never });
    expect(await viewer.list(user as never)).toEqual({ templates: [], canManage: false });
    const none = new SupplierTextTemplatesService({ repository, permissions: permissions([]) as never });
    await expect(none.list(user as never)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('write without procurement.manage → 403 with a denied audit row and no repository call', async () => {
    auditClient.query.mockClear();
    const service = new SupplierTextTemplatesService({ repository, permissions: permissions(['procurement.view']) as never, auditClient: auditClient as never });
    await expect(service.setDefault({ currentUser: user as never, commandKey: uuid, requestId: 'r-1', templateId: 4, expectedVersion: 1 }))
      .rejects.toMatchObject({ statusCode: 403, details: { requiredPermissions: ['procurement.manage'] } });
    expect(repository.setDefault).not.toHaveBeenCalled();
    const params = auditClient.query.mock.calls[0][1] as unknown[];
    expect(params).toContain('procurement.supplier_text_template_denied');
    expect(params).toContain('supplier_text_template');
  });
});
