import { describe, it, expect } from 'vitest';
import { can, PERMISSIONS } from './permissions';

describe('sheet_materials permissions (5-role alignment, user decision 2026-06-19)', () => {
  it('registers both perms in the catalog', () => {
    expect(PERMISSIONS).toContain('sheet_materials.view');
    expect(PERMISSIONS).toContain('sheet_materials.manage');
  });
  it('manage roles = superadmin/top_manager/manager/operator + admin (NOT worker/packer/viewer)', () => {
    for (const r of ['superadmin', 'top_manager', 'manager', 'operator', 'admin'] as const) {
      expect(can(r, 'sheet_materials.manage')).toBe(true);
    }
    for (const r of ['worker', 'packer', 'viewer'] as const) {
      expect(can(r, 'sheet_materials.manage')).toBe(false);
    }
  });
  it('view roles = the 5 Hasura roles + admin (NOT worker/packer)', () => {
    for (const r of ['superadmin', 'top_manager', 'manager', 'operator', 'viewer', 'admin'] as const) {
      expect(can(r, 'sheet_materials.view')).toBe(true);
    }
    expect(can('worker', 'sheet_materials.view')).toBe(false);
    expect(can('packer', 'sheet_materials.view')).toBe(false);
  });
});
