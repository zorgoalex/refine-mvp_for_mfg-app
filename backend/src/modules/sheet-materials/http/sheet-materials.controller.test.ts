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
});
