import { describe, expect, it, vi } from 'vitest';
import type { CurrentUser } from '../../../permissions/current-user';
import { CutConfigAdminService } from './cut-config-admin.service';
import type { CutConfigAdminPort } from './cut-config-admin.types';

function user(permissions: string[]): CurrentUser {
  return { id: '7', username: 'cfg', role: 'operator', permissions } as unknown as CurrentUser;
}

function fakePort(): CutConfigAdminPort {
  return {
    recordPermissionDenied: vi.fn(async () => undefined),
    getConfig: vi.fn(async () => ({ settings: [], sheetMaterialTypes: [], paramProfiles: [], renderPresets: [] })),
    updateSetting: vi.fn(async () => ({ key: 'grain.rules', value: {}, version: 1 })),
    upsertSheetMaterialType: vi.fn(async () => ({ sheetMaterialTypeId: 1, name: 'x', materialTypeId: 1, thicknessMm: 16, widthMm: 2800, heightMm: 2070, isActive: true, version: 0 })),
    deleteSheetMaterialType: vi.fn(async () => undefined),
    upsertParamProfile: vi.fn(async () => ({ cutParamProfileId: 1, name: 'x', params: {}, isDefault: false, isActive: true, version: 0 })),
    deleteParamProfile: vi.fn(async () => undefined),
    upsertRenderPreset: vi.fn(async () => ({ cutRenderPresetId: 1, name: 'x', targetPx: 360, background: '#fff', isActive: true, version: 0 })),
    deleteRenderPreset: vi.fn(async () => undefined),
  };
}

describe('CutConfigAdminService RBAC', () => {
  it('allows reads with cut.view and writes with cut.manage', async () => {
    const port = fakePort();
    const service = new CutConfigAdminService({ config: port });
    await expect(service.getConfig({ currentUser: user(['cut.view']) })).resolves.toBeTruthy();
    await expect(
      service.updateSetting({ currentUser: user(['cut.view', 'cut.manage']), key: 'grain.rules', value: {}, expectedVersion: 0 }),
    ).resolves.toBeTruthy();
  });

  it('denies a read without cut.view', async () => {
    const service = new CutConfigAdminService({ config: fakePort() });
    await expect(service.getConfig({ currentUser: user([]) })).rejects.toMatchObject({ statusCode: 403, code: 'PERMISSION_DENIED' });
  });

  it('records the denied cut-config audit carrying the request id', async () => {
    const port = fakePort();
    const service = new CutConfigAdminService({ config: port });
    await expect(
      service.updateSetting({ currentUser: user(['cut.view']), key: 'defaults', value: {}, expectedVersion: 0, requestId: 'req-9' }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await Promise.resolve();
    expect(port.recordPermissionDenied).toHaveBeenCalledWith(
      expect.objectContaining({ requiredPermissions: ['cut.manage'], requestId: 'req-9' }),
    );
  });

  it('denies every write without cut.manage (cut.view is not enough)', async () => {
    const port = fakePort();
    const service = new CutConfigAdminService({ config: port });
    const viewer = user(['cut.view']);
    await expect(service.updateSetting({ currentUser: viewer, key: 'defaults', value: {}, expectedVersion: 0 })).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.upsertSheetMaterialType({ currentUser: viewer, input: { name: 'x', materialTypeId: 1, thicknessMm: 16, widthMm: 2800, heightMm: 2070 } })).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.deleteRenderPreset({ currentUser: viewer, id: 1, expectedVersion: 0 })).rejects.toMatchObject({ statusCode: 403 });
    expect(port.upsertSheetMaterialType).not.toHaveBeenCalled();
  });
});
