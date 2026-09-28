import { describe, expect, it } from 'vitest';

import { computeOnecDocumentsPermissions } from './onecDocumentsPermissions';

describe('computeOnecDocumentsPermissions', () => {
  it('treats missing permissions as no access', () => {
    expect(computeOnecDocumentsPermissions(undefined)).toEqual({
      canView: false,
      canManage: false,
      canSeeAmounts: false,
    });
  });

  it('reads each permission independently', () => {
    expect(computeOnecDocumentsPermissions(['procurement.view'])).toEqual({
      canView: true,
      canManage: false,
      canSeeAmounts: false,
    });
    expect(computeOnecDocumentsPermissions(['procurement.view', 'procurement.manage'])).toEqual({
      canView: true,
      canManage: true,
      canSeeAmounts: false,
    });
    expect(computeOnecDocumentsPermissions(['procurement.view', 'procurement.manage', 'finance.view'])).toEqual({
      canView: true,
      canManage: true,
      canSeeAmounts: true,
    });
  });

  it('ignores unrelated permissions', () => {
    expect(computeOnecDocumentsPermissions(['orders.view'])).toEqual({
      canView: false,
      canManage: false,
      canSeeAmounts: false,
    });
  });
});
