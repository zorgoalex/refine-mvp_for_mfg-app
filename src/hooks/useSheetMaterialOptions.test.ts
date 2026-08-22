import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
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
