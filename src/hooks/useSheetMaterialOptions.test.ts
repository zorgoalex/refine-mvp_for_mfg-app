import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { toSheetSelectOptions } from './useSheetMaterialOptions';
import type { SheetMaterialTypeOption } from './useOrderFormData';

const opts: SheetMaterialTypeOption[] = [
  { value: 1, label: 'МДФ 16', widthMm: 2800, heightMm: 2070, isActive: true },
  { value: 2, label: 'МДФ 8', widthMm: 2800, heightMm: 2070, isActive: false },
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

describe('useSheetMaterialOptions gating (source guard)', () => {
  const src = readFileSync(new URL('./useSheetMaterialOptions.ts', import.meta.url), 'utf8');

  it('gates the picker on backend write AND sheet_materials.view', () => {
    expect(src).toContain("can('sheet_materials.view')");
    expect(src).toMatch(/featureFlags\.useBackendOrdersWrite\s*&&\s*canViewSheetMaterials/);
  });

  it('does not fire a Hasura sheet read unless enabled and not using backend refs', () => {
    expect(src).toMatch(/enabled:\s*enabled\s*&&\s*!useBackendReferences/);
  });
});
