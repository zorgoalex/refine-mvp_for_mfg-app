import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  getDefaultSheetMaterialTypeId,
  isSheetMaterialPickerEnabled,
  toSheetSelectOptions,
} from './useSheetMaterialOptions';
import type { SheetMaterialTypeOption } from './useOrderFormData';

const opts: SheetMaterialTypeOption[] = [
  { value: 1, label: 'МДФ 16', widthMm: 2800, heightMm: 2070, isActive: true, isCuttable: true, sortOrder: 10 },
  { value: 2, label: 'МДФ 8', widthMm: 2800, heightMm: 2070, isActive: false, isCuttable: true, sortOrder: 20 },
];

describe('toSheetSelectOptions', () => {
  it('disables an inactive option that is not the current value', () => {
    const result = toSheetSelectOptions(opts, 1);
    expect(result.find((o) => o.value === 2)?.disabled).toBe(true);
    expect(result.find((o) => o.value === 1)?.disabled).toBe(false);
  });

  it('keeps an inactive option enabled when it is the current value', () => {
    const result = toSheetSelectOptions(opts, 2);
    expect(result.find((o) => o.value === 2)?.disabled).toBe(false);
  });

  it('labels inactive options', () => {
    const result = toSheetSelectOptions(opts, 1);
    expect(result.find((o) => o.value === 2)?.label).toContain('неактивный');
  });
});

describe('getDefaultSheetMaterialTypeId', () => {
  it('uses smallest catalog sort order instead of option position', () => {
    expect(getDefaultSheetMaterialTypeId([
      { ...opts[0], value: 30, sortOrder: 90 },
      { ...opts[0], value: 20, sortOrder: 5 },
      { ...opts[0], value: 10, sortOrder: 20 },
    ])).toBe(20);
  });

  it('ignores inactive and non-cuttable materials', () => {
    expect(getDefaultSheetMaterialTypeId([
      { ...opts[0], value: 1, sortOrder: 1, isActive: false },
      { ...opts[0], value: 2, sortOrder: 2, isCuttable: false },
      { ...opts[0], value: 3, sortOrder: 3 },
    ])).toBe(3);
  });

  it('uses id as deterministic tie-breaker', () => {
    expect(getDefaultSheetMaterialTypeId([
      { ...opts[0], value: 9, sortOrder: 10 },
      { ...opts[0], value: 4, sortOrder: 10 },
    ])).toBe(4);
  });
});

describe('isSheetMaterialPickerEnabled', () => {
  it('loads backend references without the legacy Hasura schema flag', () => {
    expect(isSheetMaterialPickerEnabled(true, true, true, false)).toBe(true);
  });

  it('keeps the legacy Hasura path behind its schema flag', () => {
    expect(isSheetMaterialPickerEnabled(true, true, false, false)).toBe(false);
    expect(isSheetMaterialPickerEnabled(true, true, false, true)).toBe(true);
  });

  it('still requires backend writes and sheet-material permission', () => {
    expect(isSheetMaterialPickerEnabled(false, true, true, true)).toBe(false);
    expect(isSheetMaterialPickerEnabled(true, false, true, true)).toBe(false);
  });
});

describe('useSheetMaterialOptions gating (source guard)', () => {
  const src = readFileSync(new URL('./useSheetMaterialOptions.ts', import.meta.url), 'utf8');

  it('gates the picker on backend write and sheet_materials.view', () => {
    expect(src).toContain("can('sheet_materials.view')");
    expect(src).toContain('featureFlags.useBackendOrdersWrite');
    expect(src).toContain('featureFlags.sheetMaterialsReads');
  });

  it('does not fire a Hasura sheet read unless enabled and not using backend refs', () => {
    expect(src).toMatch(/enabled:\s*enabled\s*&&\s*!useBackendReferences/);
  });
});
