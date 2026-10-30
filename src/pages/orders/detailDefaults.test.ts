import { describe, expect, it } from 'vitest';
import {
  changedDetailDefaults,
  INITIAL_DETAIL_DEFAULTS,
  newDetailDefaults,
  noteOpenRowRuleMaterial,
  openRowDefaults,
  readDetailDefaults,
  reconcileOpenRowDefaults,
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

describe('an open untouched row follows the defaults, a field the user changed is left alone for good', () => {
  const at = (overrides: Partial<typeof INITIAL_DETAIL_DEFAULTS>) => ({ ...INITIAL_DETAIL_DEFAULTS, ...overrides });
  const open = (defaults = at({ pricePerSqm: 9500 }), options: { rule: number | undefined } = { rule: 7 }) => {
    const { rule } = options;
    const values = rowDefaultFormValues(defaults, rule);
    return { applied: openRowDefaults(1, rule, values), form: { ...values } as Record<string, unknown> };
  };
  const apply = (state: ReturnType<typeof open>, defaults: typeof INITIAL_DETAIL_DEFAULTS) => {
    const patch = reconcileOpenRowDefaults(state.applied, (field) => state.form[field], defaults);
    Object.assign(state.form, patch);
    return patch;
  };

  it('untouched fields take each new default; the price brings its marker', () => {
    const state = open();
    expect(apply(state, at({ millingTypeId: 9, pricePerSqm: 9000 }))).toEqual({
      milling_type_id: 9, milling_cost_per_sqm: 9000, prefilled_milling_cost_per_sqm: 9000,
    });
    expect(apply(state, at({ millingTypeId: 3, pricePerSqm: 10000 }))).toMatchObject({ milling_type_id: 3, milling_cost_per_sqm: 10000 });
  });

  it('a price typed by hand survives a default that equals it and every later one; the marker does not move', () => {
    const state = open();
    state.form.milling_cost_per_sqm = 9000; // typed by hand
    expect(apply(state, at({ pricePerSqm: 9000 }))).toEqual({});
    expect(apply(state, at({ pricePerSqm: 10000 }))).toEqual({});
    expect(state.form).toMatchObject({ milling_cost_per_sqm: 9000, prefilled_milling_cost_per_sqm: 9500 });
  });

  it('a milling chosen by hand stays when the defaults change twice', () => {
    const state = open();
    state.form.milling_type_id = 5;
    apply(state, at({ millingTypeId: 5 }));
    apply(state, at({ millingTypeId: 9 }));
    expect(state.form.milling_type_id).toBe(5);
  });

  it('a material the rule filled after the catalog arrived is still the defaults\' value', () => {
    const state = open(at({ pricePerSqm: null }), { rule: undefined }); // opened before the catalog
    expect(state.applied.rule).toBeUndefined();
    expect(state.form.sheet_material_type_id).toBeNull();
    state.form.sheet_material_type_id = 7; // the rule fills it later
    noteOpenRowRuleMaterial(state.applied, 7);
    expect(state.applied).toMatchObject({ rule: 7, values: expect.objectContaining({ sheet_material_type_id: 7 }) });
    expect(apply(state, at({ sheetMaterialTypeId: 12 }))).toEqual({ sheet_material_type_id: 12 });
    expect(apply(state, at({ sheetMaterialTypeId: null }))).toEqual({ sheet_material_type_id: 7 });
  });

  it('without the note the late rule material would count as the user\'s (the r8 defect this guards)', () => {
    const state = open(at({ pricePerSqm: null }), { rule: undefined });
    state.form.sheet_material_type_id = 7;
    expect(apply(state, at({ sheetMaterialTypeId: 12 }))).toEqual({});
    expect(state.applied.owned.has('sheet_material_type_id')).toBe(false);
  });
});
