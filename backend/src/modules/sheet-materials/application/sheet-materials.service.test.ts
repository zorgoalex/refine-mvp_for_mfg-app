import { describe, it, expect, vi } from 'vitest';
import { SheetMaterialsService } from './sheet-materials.service';

const port = {
  list: vi.fn().mockResolvedValue([]),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  deactivate: vi.fn(),
  recordPermissionDenied: vi.fn().mockResolvedValue(undefined),
};
const allow = { canUser: () => true } as any;
const deny = { canUser: () => false } as any;
const ctx = { currentUser: { id: '1', role: 'viewer', username: 'u' }, requestId: 'r1' } as any;

describe('SheetMaterialsService RBAC', () => {
  it('list requires sheet_materials.view (allowed)', async () => {
    const svc = new SheetMaterialsService({ repo: port as any, permissions: allow });
    await expect(svc.list(ctx)).resolves.toEqual([]);
  });
  it('create denied without sheet_materials.manage → 403 + denied-audit via port', async () => {
    const svc = new SheetMaterialsService({ repo: port as any, permissions: deny });
    await expect(svc.create({ ...ctx, input: {} as any })).rejects.toMatchObject({ statusCode: 403 });
    expect(port.recordPermissionDenied).toHaveBeenCalledWith(
      expect.objectContaining({ requiredPermissions: ['sheet_materials.manage'] }),
    );
  });
});
