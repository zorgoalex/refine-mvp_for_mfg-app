import { describe, expect, it } from 'vitest';
import { filterExtraResources } from './extraResourceFilters';

const rows = [
  { id: 1, resourceName: 'Шпон дуб', resourceKind: 'veneer', hdfAutoDefault: false, comment: '', isActive: true },
  { id: 2, resourceName: 'Краска белая', resourceKind: 'paint', hdfAutoDefault: true, comment: 'эмаль', isActive: true },
  { id: 3, resourceName: 'Старый шпон', resourceKind: 'veneer', hdfAutoDefault: false, comment: '', isActive: false },
  { resourceName: '', resourceKind: 'other', hdfAutoDefault: false, comment: '', isActive: true },
];

describe('extra resources filters', () => {
  it('hides inactive rows by default and keeps unsaved rows', () => {
    expect(filterExtraResources(rows, []).map((row) => row.id)).toEqual([1, 2, undefined]);
    expect(filterExtraResources(rows, [{ field: 'is_active', operator: 'in', value: [true, false] }]).map((row) => row.id)).toEqual([1, 2, 3, undefined]);
  });

  it('applies search, kind, flag and comment', () => {
    expect(filterExtraResources(rows, [{ field: 'resourceName', operator: 'contains', value: 'шпон' }]).map((row) => row.id)).toEqual([1, undefined]);
    expect(filterExtraResources(rows, [{ field: 'resourceKind', operator: 'eq', value: 'paint' }]).map((row) => row.id)).toEqual([2, undefined]);
    expect(filterExtraResources(rows, [{ field: 'hdfAutoDefault', operator: 'eq', value: 'true' }]).map((row) => row.id)).toEqual([2, undefined]);
    expect(filterExtraResources(rows, [{ field: 'comment', operator: 'contains', value: 'ЭМАЛЬ' }]).map((row) => row.id)).toEqual([2, undefined]);
  });

  it('keeps a row with unsaved edits visible even if the filters would hide it', () => {
    const edited = (row: { id?: number }) => row.id === 1;
    const switchedOff = rows.map((row) => (row.id === 1 ? { ...row, isActive: false } : row));
    expect(filterExtraResources(switchedOff, [], edited).map((row) => row.id)).toEqual([1, 2, undefined]);
    expect(filterExtraResources(rows, [{ field: 'resourceKind', operator: 'eq', value: 'paint' }], edited).map((row) => row.id)).toEqual([1, 2, undefined]);
  });
});
