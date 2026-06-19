import { describe, it, expect, vi } from 'vitest';
import { SheetMaterialsController } from './sheet-materials.controller';

const svc = { list: vi.fn(), getById: vi.fn(), create: vi.fn(), update: vi.fn(), deactivate: vi.fn() } as any;
// Request contract is RequestWithCurrentUser = { user?, requestId? } — field is `user`, not `currentUser`.
const reqUser = { user: { id: '1', role: 'admin', username: 'a' }, requestId: 'r' } as any;

describe('SheetMaterialsController', () => {
  it('returns 503 when feature disabled', async () => {
    const rc = { getFeatureFlags: () => ({ sheetMaterialsEnabled: false }) } as any;
    const c = new SheetMaterialsController(svc, rc);
    await expect(c.list(reqUser, undefined)).rejects.toMatchObject({ statusCode: 503 });
  });
  it('rejects invalid create body with 422', async () => {
    const rc = { getFeatureFlags: () => ({ sheetMaterialsEnabled: true }) } as any;
    const ctrl = new SheetMaterialsController(svc, rc);
    await expect(ctrl.create(reqUser, { name: '' })).rejects.toMatchObject({ statusCode: 422 });
  });

  const validBody = { name: 'ЛДСП 16', materialTypeId: 2, unitId: 1, thicknessMm: 16, widthMm: 2800, heightMm: 2070 };

  it('accepts a valid create body WITHOUT refKey1c (refKey1c is optional)', async () => {
    const rc = { getFeatureFlags: () => ({ sheetMaterialsEnabled: true }) } as any;
    svc.create.mockResolvedValueOnce({});
    const ctrl = new SheetMaterialsController(svc, rc);
    await expect(ctrl.create(reqUser, validBody)).resolves.toBeDefined();
  });

  it('accepts a non-RFC 1C-style UUID refKey1c, rejects a non-UUID with 422', async () => {
    const rc = { getFeatureFlags: () => ({ sheetMaterialsEnabled: true }) } as any;
    svc.create.mockResolvedValue({});
    const ctrl = new SheetMaterialsController(svc, rc);
    await expect(ctrl.create(reqUser, { ...validBody, refKey1c: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' })).resolves.toBeDefined();
    await expect(ctrl.create(reqUser, { ...validBody, refKey1c: 'not-a-uuid' })).rejects.toMatchObject({ statusCode: 422 });
  });
});
