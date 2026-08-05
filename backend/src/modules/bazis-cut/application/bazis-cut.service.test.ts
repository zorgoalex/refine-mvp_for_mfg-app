import { afterEach, describe, expect, it, vi } from 'vitest';
import { auditService } from '../../../common/audit/audit.service';
import type { DatabaseClient } from '../../../database/database.types';
import type { CurrentUser } from '../../../permissions/current-user';
import type { PermissionsService } from '../../../permissions/permissions.service';
import type { BazisCutRepositoryPort } from './bazis-cut.types';
import { BazisCutService } from './bazis-cut.service';

const user: CurrentUser = {
  id: '41', username: 'viewer', role: 'viewer', roleId: 7, permissions: [],
};

afterEach(() => vi.restoreAllMocks());

describe('BazisCutService denied audit', () => {
  it('records permission denial before repository lookup and still returns 403', async () => {
    const repository = { get: vi.fn() } as unknown as BazisCutRepositoryPort;
    const permissions = { canUser: vi.fn(() => false) } as unknown as PermissionsService;
    const auditDatabase = {} as DatabaseClient;
    const denied = vi.spyOn(auditService, 'recordDenied').mockResolvedValue('audit-1');
    const service = new BazisCutService(repository, permissions, auditDatabase);

    await expect(service.get({ currentUser: user, requestId: 'req-denied', setId: 99 }))
      .rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' });

    expect(repository.get).not.toHaveBeenCalled();
    expect(denied).toHaveBeenCalledWith(auditDatabase, expect.objectContaining({
      event: 'bazis_cut_set.permission_denied', entityId: 99, requestId: 'req-denied',
      requiredPermissions: ['cut.view'],
    }));
  });

  it('does not let a failed denied-audit sink mask the 403', async () => {
    const permissions = { canUser: vi.fn(() => false) } as unknown as PermissionsService;
    vi.spyOn(auditService, 'recordDenied').mockRejectedValue(new Error('audit down'));
    const service = new BazisCutService({ list: vi.fn() } as unknown as BazisCutRepositoryPort,
      permissions, {} as DatabaseClient);

    await expect(service.list({ currentUser: user, requestId: 'req-2', search: '', page: 1, pageSize: 25 }))
      .rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' });
  });

  it('uses cut.view for picker reads and cut.manage for atomic picker creation', async () => {
    const repository = {
      pickerSearch: vi.fn(async () => ({ items: [] })),
      createFromPicker: vi.fn(async () => ({ set: {} })),
    } as unknown as BazisCutRepositoryPort;
    const permissions = { canUser: vi.fn(() => true) } as unknown as PermissionsService;
    const service = new BazisCutService(repository, permissions);
    const criteria = { dateFrom: '2026-08-01', dateTo: '2026-08-05', orderIds: [], clientIds: [],
      sheetMaterialTypeIds: [], millingTypeIds: [], bazisKeys: [], designEngineerIds: [],
      dowelingOrderIds: [], excludedDetailIds: [] };

    await service.pickerSearch({ currentUser: user, criteria, page: 1, pageSize: 25 });
    await service.createFromPicker({ currentUser: user, criteria, criteriaHash: 'a'.repeat(64),
      details: [{ detailId: 1, selectionToken: 'b'.repeat(64) }], idempotencyKey: 'picker-key-123' });

    expect(permissions.canUser).toHaveBeenNthCalledWith(1, user, 'cut.view');
    expect(permissions.canUser).toHaveBeenNthCalledWith(2, user, 'cut.manage');
  });

  it('protects legacy membership fallback with orders.view', async () => {
    const repository = {
      orderMemberships: vi.fn(async () => ({ orderId: 9, details: [] })),
    } as unknown as BazisCutRepositoryPort;
    const permissions = { canUser: vi.fn(() => true) } as unknown as PermissionsService;
    const service = new BazisCutService(repository, permissions);

    await service.orderMemberships({ currentUser: user, orderId: 9 });

    expect(permissions.canUser).toHaveBeenCalledWith(user, 'orders.view');
  });
});
