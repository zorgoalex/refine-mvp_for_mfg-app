import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

// SP3 Task 10b: synthetic sheet-shadow materials must be invisible in user-facing
// materials reads, and backend-owned SP3 control columns must never leave the FE
// through a legacy Hasura create/update payload (defense-in-depth with the Hasura
// write-isolation perms). Verified as source-text guards (node env, no DOM).
const src = readFileSync(new URL('./dataProvider.ts', import.meta.url), 'utf8');

describe('dataProvider hides is_sheet_shadow materials from user-facing reads', () => {
  it('default-filters materials by is_sheet_shadow = false in getList', () => {
    // a materials-scoped default filter that adds is_sheet_shadow = false
    expect(src).toMatch(
      /resource === ['"]materials['"][\s\S]{0,400}is_sheet_shadow[\s\S]{0,120}value:\s*false/,
    );
  });

  it('respects an explicit is_sheet_shadow filter (internal opt-in escape)', () => {
    // the default must NOT be applied when the caller already passed is_sheet_shadow
    expect(src).toMatch(/f\.field === ['"]is_sheet_shadow['"]/);
  });
});

describe('dataProvider gates all SP3 schema reads on the sheetMaterialsReads flag', () => {
  it('only adds the is_sheet_shadow filter when the SP3 schema flag is on', () => {
    // the migration-029 column must not be referenced in a where-clause before the
    // Hasura metadata is applied, else legacy materials reads 400 ("field not found")
    expect(src).toMatch(
      /resource === ['"]materials['"]\s*&&\s*featureFlags\.sheetMaterialsReads/,
    );
  });

  it('strips migration-029 sheet columns from the selection when the flag is off', () => {
    expect(src).toContain('SHEET_SCHEMA_FIELDS');
    expect(src).toMatch(/if\s*\(\s*!featureFlags\.sheetMaterialsReads\s*\)/);
    // the gated columns include the order/orders_view/order_details sheet link
    expect(src).toMatch(/sheet_material_type_id/);
    expect(src).toMatch(/sheet_eligible/);
  });
});

describe('dataProvider strips backend-owned SP3 control columns from legacy writes', () => {
  const controlColumns = [
    'sheet_eligible',
    'sheet_material_type_id',
    'is_sheet_shadow',
    'shadow_of_sheet_material_type_id',
  ];

  const writeSlice = (method: string) => {
    const start = src.indexOf(`${method}: async ({`);
    expect(start).toBeGreaterThan(-1);
    // far enough to include the destructure that omits id/audit/control columns
    return src.slice(start, start + 2400);
  };

  it('create omits every control column from the insert payload', () => {
    const slice = writeSlice('create');
    for (const col of controlColumns) {
      expect(slice).toContain(col);
    }
  });

  it('update omits every control column from the _set payload', () => {
    const slice = writeSlice('update');
    for (const col of controlColumns) {
      expect(slice).toContain(col);
    }
  });
});
