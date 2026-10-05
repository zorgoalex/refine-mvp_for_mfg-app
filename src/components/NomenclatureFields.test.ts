import { describe, expect, it } from 'vitest';
import { nomenclaturePayload, supportsNomenclature } from './NomenclatureFields';

describe('nomenclature fields helpers', () => {
  it('detects backend support by the presence of the field and sends nothing to an old backend', () => {
    expect(supportsNomenclature({ note: null })).toBe(true);
    expect(supportsNomenclature({ name: 'x' })).toBe(false);
    expect(nomenclaturePayload({ note: 'x' }, false)).toEqual({});
    expect(nomenclaturePayload({ nomenclatureType: ' Запас ', nomenclatureCategory: '  ', note: undefined }, true))
      .toEqual({ nomenclatureType: 'Запас', nomenclatureCategory: null, note: null });
  });
});
