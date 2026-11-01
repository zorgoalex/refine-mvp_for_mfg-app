import { describe, expect, it } from 'vitest';
import {
  additionalWithoutMain,
  composeSheetSuppliers,
  parseSupplierIds,
  sameIds,
  supplierRelatedEntities,
} from './material-suppliers';

const ref = (id: number) => ({ id, name: `S${id}`, isActive: true });

describe('material suppliers helpers', () => {
  it('parses a list: absent = keep, null = clear, repeats and junk rejected', () => {
    expect(parseSupplierIds(undefined, 'ids')).toBeUndefined();
    expect(parseSupplierIds(null, 'ids')).toBeNull();
    expect(parseSupplierIds([3, 1], 'ids')).toEqual([3, 1]);
    expect(() => parseSupplierIds([1, 1], 'ids')).toThrow(/дважды/);
    expect(() => parseSupplierIds([0], 'ids')).toThrow();
    expect(() => parseSupplierIds(Array.from({ length: 21 }, (_, i) => i + 1), 'ids')).toThrow();
  });

  it('sheet list: main first, the main repeated in the additional ones is shown once', () => {
    expect(composeSheetSuppliers(ref(2), [ref(5), ref(2), ref(7)]).map((s) => s.id)).toEqual([2, 5, 7]);
    expect(composeSheetSuppliers(null, [ref(5)]).map((s) => s.id)).toEqual([5]);
    expect(additionalWithoutMain(5, [5, 7])).toEqual([7]);
    expect(additionalWithoutMain(null, [5, 7])).toEqual([5, 7]);
  });

  it('audit relations cover removed and added suppliers once', () => {
    expect(supplierRelatedEntities([3, 1], [1, 4])).toEqual([
      { entityType: 'supplier', entityId: 1 }, { entityType: 'supplier', entityId: 3 }, { entityType: 'supplier', entityId: 4 },
    ]);
    expect(sameIds([1, 2], [1, 2])).toBe(true);
    expect(sameIds([1, 2], [2, 1])).toBe(false);
  });
});
