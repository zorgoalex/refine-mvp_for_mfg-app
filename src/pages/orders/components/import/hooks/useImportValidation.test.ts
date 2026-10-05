import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

import {
  filmResolutionWarning,
  findReferenceId,
  normalizeReferenceName,
  refreshPendingFilmRows,
  resolveFilmReference,
  resolveImportRow,
} from './useImportValidation';
import { IMPORT_DEFAULTS, type FilmNameIndexStatus, type ReferenceData, type ValidatedRow } from '../types/importTypes';

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

describe('film resolution waits for the film name index (code review R4-1)', () => {
  // Плёнка 42 переименована из «Орех» в «Орех Милано»; активная плёнка 77 сейчас называется «Орех».
  const films = [{ id: 42, name: 'Орех Милано; Гульсум' }, { id: 77, name: 'Орех' }];
  const index = [
    { name: 'Орех', filmId: 42, canonicalFilmId: 42, vendorId: 1, active: true, source: 'history' as const },
    { name: 'Орех', filmId: 77, canonicalFilmId: 77, vendorId: 2, active: true, source: 'current' as const },
    { name: 'Белый', filmId: 5, canonicalFilmId: 5, vendorId: 1, active: true, source: 'current' as const },
  ];
  const refData = (status: FilmNameIndexStatus): ReferenceData => ({
    edgeTypes: [],
    films: [...films, { id: 5, name: 'Белый' }],
    filmNameIndex: status === 'ready' ? index : [],
    filmNameIndexStatus: status,
    millingTypes: [],
    sheetMaterialTypes: [],
  });
  const pendingRow = (filmName: string, status: FilmNameIndexStatus): ValidatedRow => {
    const resolution = resolveFilmReference(filmName, refData(status));
    const warning = filmResolutionWarning(filmName, resolution, refData(status));
    return {
      filmName, height: 100, width: 100, quantity: 1,
      film_id: resolution.filmId, filmPendingIndex: resolution.pendingIndex,
      isValid: true, errors: [], warnings: warning ? [warning] : [],
    };
  };

  it('does not auto-select the current-name film while the index is loading', () => {
    const row = pendingRow('Орех', 'loading');
    expect(row.film_id).toBeNull();
    expect(row.filmPendingIndex).toBe(true);
    expect(row.warnings[0].message).toContain('Проверяются прежние названия');
  });

  it('requires a manual choice when the index is unavailable', () => {
    const row = pendingRow('Орех', 'unavailable');
    expect(row.film_id).toBeNull();
    expect(row.warnings[0].message).toContain('выберите плёнку для "Орех" вручную');
  });

  it('re-resolves pending rows after a late index load and keeps manual choices', () => {
    const rows = [
      pendingRow('Орех', 'loading'),
      pendingRow('Белый', 'loading'),
      { ...pendingRow('Белый', 'loading'), film_id: 77, filmPendingIndex: false, warnings: [] },
      { ...pendingRow('Орех', 'loading'), filmPendingIndex: false },
    ];
    const refreshed = refreshPendingFilmRows(rows, refData('ready'));
    // «Орех» — текущее имя 77 и прежнее имя 42: выбор за пользователем.
    expect(refreshed[0]).toMatchObject({ film_id: null, filmPendingIndex: false });
    expect(refreshed[0].warnings.map(({ message }) => message)).toEqual([
      'Найдено несколько канонических плёнок для "Орех". Выберите вручную.',
    ]);
    expect(refreshed[1]).toMatchObject({ film_id: 5, filmPendingIndex: false, warnings: [] });
    // Ручной выбор и ручная очистка не перезаписываются.
    expect(refreshed[2]).toBe(rows[2]);
    expect(refreshed[3]).toBe(rows[3]);
  });

  it('switches the pending warning when the index becomes unavailable and is stable otherwise', () => {
    const rows = [pendingRow('Орех', 'loading')];
    expect(refreshPendingFilmRows(rows, refData('loading'))).toBe(rows);
    const unavailable = refreshPendingFilmRows(rows, refData('unavailable'));
    expect(unavailable[0]).toMatchObject({ film_id: null, filmPendingIndex: true });
    expect(unavailable[0].warnings[0].message).toContain('вручную');
    expect(refreshPendingFilmRows(unavailable, refData('unavailable'))).toBe(unavailable);
  });

  it('keeps legacy behaviour for consumers without an index status', () => {
    const legacy = { ...refData('ready'), filmNameIndex: undefined, filmNameIndexStatus: undefined };
    expect(resolveFilmReference('Орех', legacy)).toEqual({ filmId: 77, ambiguous: false, pendingIndex: false });
  });

  it('all order import modals pass the index status and block import while it loads', () => {
    for (const modal of ['ExcelImportModal.tsx', 'PdfImportModal.tsx', 'VlmImportModal.tsx']) {
      const source = readFileSync(resolve(__dirname, '..', modal), 'utf8');
      expect(source, modal).toContain("filmNameIndexStatus: filmsLoading ? 'loading' : filmNameIndex.status");
      expect(source, modal).toContain('const { data: filmsData, isLoading: filmsLoading } = useList({');
      expect(source, modal).toContain('importValidation.stats.validRows === 0 || importValidation.filmIndexLoading');
    }
  });
});
