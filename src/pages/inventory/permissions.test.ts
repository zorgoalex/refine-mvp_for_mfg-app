import { describe, expect, it } from 'vitest';
import { can } from '../../utils/permissions';

describe('inventory permissions use literal membership', () => {
  it('grants view and manage only when exact permissions exist', () => {
    expect(can('inventory.view', { permissions: ['inventory.view'] })).toBe(true);
    expect(can('inventory.manage', { permissions: ['inventory.view'] })).toBe(false);
    expect(can('inventory.manage', { permissions: ['inventory.manage'] })).toBe(true);
    expect(can('inventory.view', { permissions: ['inventory.viewer'] })).toBe(false);
  });
});
