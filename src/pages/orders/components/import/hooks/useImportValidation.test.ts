import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

import { findReferenceId, normalizeReferenceName, resolveImportRow } from './useImportValidation';
import { IMPORT_DEFAULTS } from '../types/importTypes';

describe('reference matching', () => {
  it('matches material names with optional spaces before millimeters', () => {
    const materials = [
      { id: 1, name: 'МДФ 16мм' },
      { id: 2, name: 'МДФ 18 мм' },
    ];

    expect(findReferenceId('МДФ 16 мм', materials)).toBe(1);
    expect(findReferenceId('МДФ 18мм', materials)).toBe(2);
  });

  it('normalizes e/yo spelling for reference names', () => {
    expect(normalizeReferenceName('Плёнка матовая')).toBe('пленка матовая');
  });
});

describe('resolveImportRow — sheet material resolution (Variant B)', () => {
  it('resolves an imported material name to a sheet_material_type_id', () => {
    const row = resolveImportRow(
      { materialName: 'МДФ 16мм' },
      { sheetMaterialTypes: [{ id: 2, name: 'МДФ 16мм', isCuttable: true }] },
    );
    expect(row.sheet_material_type_id).toBe(2);
    expect(row.material_id ?? null).toBeNull();
  });

  it('does NOT resolve a material name that matches a non-cuttable type', () => {
    const row = resolveImportRow(
      { materialName: 'Краска синяя' },
      { sheetMaterialTypes: [{ id: 5, name: 'Краска синяя', isCuttable: false }] },
    );
    // Non-cuttable types must not be resolved onto order details
    expect(row.sheet_material_type_id).toBeNull();
  });

  it('resolves when isCuttable is true', () => {
    const row = resolveImportRow(
      { materialName: 'ЛДСП 16мм' },
      {
        sheetMaterialTypes: [
          { id: 10, name: 'ЛДСП 16мм', isCuttable: true },
          { id: 11, name: 'Краска', isCuttable: false },
        ],
      },
    );
    expect(row.sheet_material_type_id).toBe(10);
    expect(row.material_id ?? null).toBeNull();
  });

  it('returns null sheet_material_type_id when name is unresolvable', () => {
    const row = resolveImportRow(
      { materialName: 'Неизвестный материал' },
      { sheetMaterialTypes: [{ id: 3, name: 'МДФ 16мм', isCuttable: true }] },
    );
    expect(row.sheet_material_type_id).toBeNull();
  });

  it('returns null sheet_material_type_id when no materialName', () => {
    const row = resolveImportRow(
      { materialName: null },
      { sheetMaterialTypes: [{ id: 3, name: 'МДФ 16мм', isCuttable: true }] },
    );
    expect(row.sheet_material_type_id).toBeNull();
  });
});

describe('IMPORT_DEFAULTS — no numeric material_id (Variant B)', () => {
  it('does not set a numeric material_id default (Critic R6 M2)', () => {
    // IMPORT_DEFAULTS must not contain a numeric material_id so imported rows
    // seed material_id: null rather than a hardcoded legacy materials.material_id.
    const materialDefault = (IMPORT_DEFAULTS as Record<string, unknown>)['material_id'];
    expect(typeof materialDefault === 'number').toBe(false);
  });
});

describe('importTypes.ts source guards', () => {
  const source = readFileSync(
    resolve(__dirname, '../types/importTypes.ts'),
    'utf8',
  );

  it('ValidatedRow declares sheet_material_type_id', () => {
    expect(source).toContain('sheet_material_type_id');
  });

  it('ReferenceData declares sheetMaterialTypes', () => {
    expect(source).toContain('sheetMaterialTypes');
  });

  it('IMPORT_DEFAULTS does not contain a numeric material_id literal', () => {
    // Must not have "material_id: <number>" in IMPORT_DEFAULTS block
    expect(source).not.toMatch(/IMPORT_DEFAULTS\s*=\s*\{[^}]*material_id\s*:\s*\d+/s);
  });
});
