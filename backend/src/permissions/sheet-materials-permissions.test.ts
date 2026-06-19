import { describe, it, expect } from 'vitest';
import { can, PERMISSIONS } from './permissions';

describe('sheet_materials permissions (5-role alignment, user decision 2026-06-19)', () => {
  it('registers both perms in the catalog', () => {
    expect(PERMISSIONS).toContain('sheet_materials.view');
    expect(PERMISSIONS).toContain('sheet_materials.manage');
  });
  it('manage roles = superadmin/top_manager/manager/operator (NOT admin/worker/viewer)', () => {
    for (const r of ['superadmin', 'top_manager', 'manager', 'operator'] as const) {
      expect(can(r, 'sheet_materials.manage')).toBe(true);
    }
    for (const r of ['admin', 'worker', 'viewer'] as const) {
      expect(can(r, 'sheet_materials.manage')).toBe(false);
    }
  });
  it('view roles = the 5 Hasura roles +viewer (NOT admin/worker)', () => {
    for (const r of ['superadmin', 'top_manager', 'manager', 'operator', 'viewer'] as const) {
      expect(can(r, 'sheet_materials.view')).toBe(true);
    }
    for (const r of ['admin', 'worker'] as const) {
      expect(can(r, 'sheet_materials.view')).toBe(false);
    }
  });
});
