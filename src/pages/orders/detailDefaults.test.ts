import { describe, expect, it } from 'vitest';
import {
  changedDetailDefaults,
  INITIAL_DETAIL_DEFAULTS,
  newDetailDefaults,
  readDetailDefaults,
  rowDefaultFormValues,
} from './detailDefaults';

describe('detail defaults of the order form', () => {
  it('untouched — the long-standing new-row values (Модерн, р-1, the material rule)', () => {
    expect(newDetailDefaults(INITIAL_DETAIL_DEFAULTS, 7)).toEqual({
      milling_type_id: 1, edge_type_id: 1, sheet_material_type_id: 7,
    });
    expect(newDetailDefaults(INITIAL_DETAIL_DEFAULTS, undefined)).toEqual({ milling_type_id: 1, edge_type_id: 1 });
    expect(changedDetailDefaults(INITIAL_DETAIL_DEFAULTS)).toBe(0);
  });

  it('chosen values go into the new row; a chosen material wins over the rule; the price carries its marker', () => {
    const defaults = { sheetMaterialTypeId: 12, filmId: 40, millingTypeId: 3, edgeTypeId: 2, pricePerSqm: 9500 };
    expect(newDetailDefaults(defaults, 7)).toEqual({
      milling_type_id: 3, edge_type_id: 2, sheet_material_type_id: 12, film_id: 40,
      milling_cost_per_sqm: 9500, prefilled_milling_cost_per_sqm: 9500,
    });
    expect(changedDetailDefaults(defaults)).toBe(5);
  });

  it('empty or invalid values do not overwrite the row', () => {
    const defaults = { ...INITIAL_DETAIL_DEFAULTS, filmId: 0, millingTypeId: 0, pricePerSqm: 0 };
    expect(newDetailDefaults(defaults, 7)).toEqual({ milling_type_id: 1, edge_type_id: 1, sheet_material_type_id: 7 });
  });

  it('reads back only well-formed defaults from the tab checkpoint', () => {
    const chosen = { sheetMaterialTypeId: 12, filmId: null, millingTypeId: 3, edgeTypeId: 2, pricePerSqm: 9500 };
    expect(readDetailDefaults(JSON.parse(JSON.stringify(chosen)))).toEqual(chosen);
    expect(readDetailDefaults({ ...chosen, millingTypeId: 0 })).toBeNull();
    expect(readDetailDefaults({ ...chosen, pricePerSqm: 'x' })).toBeNull();
    expect(readDetailDefaults(undefined)).toBeNull();
  });
});

describe('form values of an opened untouched row', () => {
  it('every field is explicit, so a later change of the defaults knows which ones are still theirs', () => {
    expect(rowDefaultFormValues(INITIAL_DETAIL_DEFAULTS, 7)).toEqual({
      milling_type_id: 1, edge_type_id: 1, sheet_material_type_id: 7, film_id: null,
      milling_cost_per_sqm: null, prefilled_milling_cost_per_sqm: null,
    });
    expect(rowDefaultFormValues({ ...INITIAL_DETAIL_DEFAULTS, millingTypeId: 9, pricePerSqm: 9500 }, 7)).toMatchObject({
      milling_type_id: 9, milling_cost_per_sqm: 9500, prefilled_milling_cost_per_sqm: 9500,
    });
  });
});
