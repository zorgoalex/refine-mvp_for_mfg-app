import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { SupplierTextTemplatesService } from '../application/supplier-text-templates.service';
import {
  createTemplateSchema,
  MySupplierTextTemplatesController,
  SupplierTextTemplatesController,
  updateTemplateSchema,
  versionSchema,
} from './supplier-text-templates.controller';
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

describe('MySupplierTextTemplatesController (personal templates route)', () => {
  it('503 SUPPLIER_TEXT_TEMPLATES_DISABLED when its flag or any parent flag is off', async () => {
    for (const off of ['supplierTextTemplatesEnabled', 'supplierRequestsEnabled', 'procurementWorkspaceEnabled', 'resourceProcurementEnabled']) {
      const service = { listMine: vi.fn() } as unknown as SupplierTextTemplatesService;
      const controller = new MySupplierTextTemplatesController(service, flags({ [off]: false }) as never);
      await expect(controller.list(request as never)).rejects.toMatchObject({ statusCode: 503, code: 'SUPPLIER_TEXT_TEMPLATES_DISABLED' });
      expect(service.listMine).not.toHaveBeenCalled();
    }
  });

  it('writes refused in read-only mode; commands pass commandKey, version, id and requestId; the user comes from the session only', async () => {
    const readOnly = new MySupplierTextTemplatesController({ create: vi.fn() } as never, flags({ ordersReadOnly: true }) as never);
    await expect(readOnly.create(request as never, {})).rejects.toMatchObject({ statusCode: 503 });
    const service = { setDefault: vi.fn().mockResolvedValue({}), remove: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}), create: vi.fn() };
    const controller = new MySupplierTextTemplatesController(service as never, flags() as never);
    await controller.setDefault(request as never, '7', { commandKey: uuid, expectedVersion: 3, expectedDefaultRevision: 0 });
    expect(service.setDefault).toHaveBeenCalledWith({ commandKey: uuid, expectedVersion: 3, expectedDefaultRevision: 0, templateId: 7, currentUser: user, requestId: 'r-1' });
    // Ревизия личного выбора обязательна: без неё устаревшее намерение нельзя отличить.
    await expect(controller.setDefault(request as never, '7', { commandKey: uuid, expectedVersion: 3 })).rejects.toMatchObject({ statusCode: 422 });
    await expect(controller.remove(request as never, '0', { commandKey: uuid, expectedVersion: 1 })).rejects.toMatchObject({ statusCode: 422 });
    await expect(controller.update(request as never, '7', { commandKey: uuid })).rejects.toMatchObject({ statusCode: 422 });
    expect(service.update).not.toHaveBeenCalled();
    // Владелец в теле запроса не принимается: схема строгая.
    await expect(controller.create(request as never, { commandKey: uuid, name: 'A', body: '{номер}', lineTemplate: '{материал}', ownerUserId: 2 }))
      .rejects.toMatchObject({ statusCode: 422 });
    expect(service.create).not.toHaveBeenCalled();
  });
});

describe('SupplierTextTemplatesController (previous route: shared templates, read-only)', () => {
  it('GET returns shared templates; every command is a definite 409 without touching the service', async () => {
    const service = { listShared: vi.fn().mockResolvedValue({ templates: [], canManage: false }), create: vi.fn(), update: vi.fn(), remove: vi.fn(), setDefault: vi.fn() };
    const controller = new SupplierTextTemplatesController(service as never, flags() as never);
    expect(await controller.list(request as never)).toEqual({ templates: [], canManage: false });
    for (const call of [
      () => controller.create(request as never),
      () => controller.update(request as never),
      () => controller.remove(request as never),
      () => controller.setDefault(request as never),
    ]) {
      expect(call).toThrowError(expect.objectContaining({ statusCode: 409, code: 'SUPPLIER_TEXT_TEMPLATE_SHARED_READ_ONLY' }));
    }
    for (const method of [service.create, service.update, service.remove, service.setDefault]) expect(method).not.toHaveBeenCalled();
  });

  it('commands keep the flag gate: disabled → 503, not 409', () => {
    const controller = new SupplierTextTemplatesController({} as never, flags({ supplierTextTemplatesEnabled: false }) as never);
    expect(() => controller.create(request as never)).toThrowError(expect.objectContaining({ statusCode: 503 }));
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
  const repository = {
    listShared: vi.fn().mockResolvedValue([]), listVisible: vi.fn().mockResolvedValue({ templates: [], defaultRevision: 3 }),
    create: vi.fn(), update: vi.fn(), remove: vi.fn(), setDefault: vi.fn().mockResolvedValue({ changed: true }),
  };
  const auditClient = { query: vi.fn().mockResolvedValue({ rows: [{ audit_id: 'a1' }], rowCount: 1 }) };
  const permissions = (granted: string[]) => ({ canUser: (_: unknown, permission: string) => granted.includes(permission) });

  it('reads need procurement.view; shared list is never manageable; own templates are editable by a viewer', async () => {
    const viewer = new SupplierTextTemplatesService({ repository, permissions: permissions(['procurement.view', 'procurement.manage']) as never });
    expect(await viewer.listShared(user as never)).toEqual({ templates: [], canManage: false });
    expect(await viewer.listMine(user as never)).toEqual({ templates: [], canEditOwn: true, defaultRevision: 3 });
    expect(repository.listVisible).toHaveBeenCalledWith(user);
    const none = new SupplierTextTemplatesService({ repository, permissions: permissions([]) as never });
    await expect(none.listShared(user as never)).rejects.toMatchObject({ statusCode: 403 });
    await expect(none.listMine(user as never)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('a command with procurement.view only is allowed (personal data); without it → 403 with a denied audit row and no repository call', async () => {
    const viewer = new SupplierTextTemplatesService({ repository, permissions: permissions(['procurement.view']) as never, auditClient: auditClient as never });
    await viewer.setDefault({ currentUser: user as never, commandKey: uuid, requestId: 'r-1', templateId: 4, expectedVersion: 1, expectedDefaultRevision: 0 });
    expect(repository.setDefault).toHaveBeenCalledTimes(1);
    repository.setDefault.mockClear();
    auditClient.query.mockClear();
    const service = new SupplierTextTemplatesService({ repository, permissions: permissions(['procurement.manage']) as never, auditClient: auditClient as never });
    await expect(service.setDefault({ currentUser: user as never, commandKey: uuid, requestId: 'r-1', templateId: 4, expectedVersion: 1, expectedDefaultRevision: 0 }))
      .rejects.toMatchObject({ statusCode: 403, details: { requiredPermissions: ['procurement.view'] } });
    expect(repository.setDefault).not.toHaveBeenCalled();
    const params = auditClient.query.mock.calls[0][1] as unknown[];
    expect(params).toContain('procurement.supplier_text_template_denied');
    expect(params).toContain('supplier_text_template');
  });
});
