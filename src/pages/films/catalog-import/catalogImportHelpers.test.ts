import { describe, expect, it } from 'vitest';
import { catalogImportActions, catalogImportErrorMessage, filmReferenceViewAllowed, importManageAllowed, inspectCatalogSheets, catalogMatchQuery, catalogRowsQuery, onecMirrorAllowed, resolveIdempotencyKey, sha256File, vendorMappingAction, serverPagination, DECISIONS_SKIP_LABELS, decisionsDownloadName, isDecisionsBatch, readDecisionsFile, sourceLabel, batchSourceName, counterLabel, formatCounter, matchStatusLabel, rowStatusLabel } from './catalogImportHelpers';

describe('film catalog import helpers', () => {
  it('inspects matching sheets from browser cell arrays and reports invalid rows', () => {
    const sheets = inspectCatalogSheets([
      { name: 'Производитель', rows: [['Наименование']] },
      { name: 'Каталог', rows: [
        ['Наименование материала Оригинал', 'Наименование материала и Поставщик', 'Поставщик', 'ТипНоменклатуры'],
        ['Дуб', 'Дуб; Decor', 'Decor', 'Запас'], ['', 'Без названия; Decor', 'Decor', 'Запас'],
      ] },
    ]);
    expect(sheets).toHaveLength(1);
    expect(sheets[0]).toMatchObject({ name: 'Каталог', validCount: 1, errorCount: 1 });
    expect(sheets[0].rows[0]).toEqual({ rowNo: 2, nameOriginal: 'Дуб', nameFull: 'Дуб; Decor', supplier: 'Decor', nomenclatureType: 'Запас', unit: null, nomenclatureCategory: null });
  });

  it('bounds server pagination and omits blank filters', () => {
    expect(catalogMatchQuery({ search: '  дуб ', offset: -4, limit: 900, status: '', vendorId: undefined })).toEqual({ status: undefined, vendorId: undefined, search: 'дуб', rowId: undefined, offset: 0, limit: 500 });
    expect(catalogRowsQuery({ conflict: false, search: ' ', offset: 20, limit: 0 })).toEqual({ status: undefined, conflict: undefined, search: undefined, offset: 20, limit: 1 });
  });

  it('builds vendor mapping actions and checks literal permissions', () => {
    expect(vendorMappingAction('decor', 17)).toEqual({ type: 'setVendor', supplierNorm: 'decor', vendorId: 17 });
    expect(vendorMappingAction('decor', null)).toEqual({ type: 'createVendor', supplierNorm: 'decor' });
    expect(importManageAllowed(['references.view'])).toBe(false);
    expect(importManageAllowed(['references.manage'])).toBe(true);
    expect(onecMirrorAllowed(['onec.manage'])).toBe(false);
    expect(onecMirrorAllowed(['onec.view'])).toBe(true);
    expect(filmReferenceViewAllowed(['references.manage'])).toBe(false);
    expect(filmReferenceViewAllowed(['references.view'])).toBe(true);
  });

  it('builds typed PATCH actions for match, group, properties and options', () => {
    expect(catalogImportActions.acceptAllAuto()).toEqual({ type: 'acceptAllAuto' });
    expect(catalogImportActions.setMatch(8, null)).toEqual({ type: 'setMatch', filmId: 8, rowId: null });
    expect(catalogImportActions.confirmMatch(8)).toEqual({ type: 'confirmMatch', filmId: 8 });
    expect(catalogImportActions.setCanonical(4, 8)).toEqual({ type: 'setCanonical', rowId: 4, filmId: 8 });
    expect(catalogImportActions.setCanonicalProperties(4, true, 3)).toEqual({ type: 'setCanonicalProperties', rowId: 4, filmTexture: true, filmTypeId: 3 });
    expect(catalogImportActions.setCreateMissing(false)).toEqual({ type: 'setOption', createMissing: false });
  });

  it('reuses a key only for retry of same pending intent', () => {
    const create = () => 'uuid-2';
    const pending = { signature: 'batch:3:apply', key: 'uuid-1' };
    expect(resolveIdempotencyKey(pending, 'batch:3:apply', create)).toBe(pending);
    expect(resolveIdempotencyKey(pending, 'batch:4:apply', create)).toEqual({ signature: 'batch:4:apply', key: 'uuid-2' });
  });

  it('hashes file bytes as lowercase SHA-256', async () => {
    const file = { arrayBuffer: async () => new TextEncoder().encode('film').buffer } as File;
    expect(await sha256File(file)).toBe('d0607f7ad2628b2af9158dfba06ce87166e66b15bf68f8f358f9aa27ccb7c321');
  });

  it('formats stale, conflict and unresolved errors with structured details', () => {
    expect(catalogImportErrorMessage({ code: 'CATALOG_IMPORT_STALE' })).toMatchObject({ reload: true });
    expect(catalogImportErrorMessage({ code: 'CATALOG_IMPORT_CONFLICT', details: { conflicts: [{ filmId: 4, reason: 'changed' }] } })).toMatchObject({ reload: false, details: ['changed — Плёнка 4'] });
    expect(catalogImportErrorMessage({ code: 'CATALOG_IMPORT_UNRESOLVED', details: { blockers: ['vendor required'] } }).details).toEqual(['vendor required']);
  });
});

describe('serverPagination', () => {
  it('changes the page size and returns to the first page', () => {
    const calls: string[] = [];
    const pagination = serverPagination(100, 50, 400, (offset) => calls.push(`offset=${offset}`), (size) => calls.push(`size=${size}`));
    expect(pagination).toMatchObject({ current: 3, pageSize: 50, total: 400, showSizeChanger: true });
    pagination.onChange(3, 100);
    expect(calls).toEqual(['size=100', 'offset=0']);
  });

  it('moves between pages with the current size', () => {
    const offsets: number[] = [];
    serverPagination(0, 20, 400, (offset) => offsets.push(offset), () => undefined).onChange(4, 20);
    expect(offsets).toEqual([60]);
  });
});

describe('decisions file helpers', () => {
  it('accepts only a decisions file', () => {
    const file = { format: 'erp.film-catalog-decisions', version: 1, fingerprintVersion: 1, sourceBatchId: 3, exportedAt: 'x', sha256: 'a'.repeat(64), rows: [], vendors: [] };
    expect(readDecisionsFile(JSON.stringify(file))).toEqual(file);
    expect(() => readDecisionsFile('{')).toThrow('Файл не является JSON');
    expect(() => readDecisionsFile(JSON.stringify({ format: 'other', rows: [] }))).toThrow('Это не файл решений');
    expect(() => readDecisionsFile('null')).toThrow('Это не файл решений');
    expect(() => readDecisionsFile(JSON.stringify({ format: 'erp.film-catalog-decisions', rows: [], sha256: 'x' }))).toThrow('повреждён');
    expect(() => readDecisionsFile(JSON.stringify({ ...file, exportedAt: 5 }))).toThrow('повреждён');
    const { exportedAt: _missing, ...noDate } = file;
    expect(() => readDecisionsFile(JSON.stringify(noDate))).toThrow('повреждён');
  });

  it('labels decisions batches and skip reasons', () => {
    expect(sourceLabel({ sourceKind: 'file', fileName: 'decisions:3.json' })).toBe('Файл решений');
    expect(sourceLabel({ sourceKind: 'file', fileName: 'каталог.xlsx' })).toBe('Файл');
    expect(sourceLabel({ sourceKind: 'onec_mirror', fileName: null })).toBe('Зеркало 1С');
    expect(isDecisionsBatch({ options: { decisions: {} } })).toBe(true);
    expect(isDecisionsBatch({ options: {} })).toBe(false);
    expect(Object.keys(DECISIONS_SKIP_LABELS).sort()).toEqual(['canonical_skipped', 'changed', 'exists', 'missing', 'no_films']);
    expect(decisionsDownloadName(3)).toBe('решения-каталога-1С-пакет-3.json');
  });

  it('shows the batch counters in Russian with Russian digit grouping; an unknown counter stays visible', () => {
    // Every counter the backend writes has a Russian label.
    for (const key of ['rows', 'rowsOk', 'rowsInvalid', 'rowsSkipped', 'films', 'linked', 'auto', 'suggested', 'confirmed', 'manual', 'none', 'unchanged', 'toRename', 'toMerge', 'toCreate', 'unresolvedGroups', 'decisionsSkipped', 'appliedFilms']) {
      expect(counterLabel(key), key).toMatch(/[А-Яа-я]/);
      expect(counterLabel(key), key).not.toBe(key);
    }
    expect(counterLabel('toMerge')).toBe('К объединению (дубли)');
    expect(counterLabel('futureCounter')).toBe('futureCounter');
    expect(formatCounter(2052).replace(/\s/g, ' ')).toBe('2 052');
    expect(formatCounter(0)).toBe('0');
    expect(formatCounter(undefined)).toBe('—');
  });

  it('names the decisions file source in Russian instead of the technical file name', () => {
    expect(batchSourceName({ id: 1, fileName: 'decisions:7.json' })).toBe('файл решений пакета №7');
    expect(batchSourceName({ id: 2, fileName: 'Пленка_ПВХ_1С.xlsx' })).toBe('Пленка_ПВХ_1С.xlsx');
    expect(batchSourceName({ id: 3, fileName: null, onecCategoryName: 'ПЛЕНКА ПВХ ДЛЯ МДФ' })).toBe('ПЛЕНКА ПВХ ДЛЯ МДФ');
    expect(batchSourceName({ id: 4 })).toBe('Пакет 4');
  });

  it('shows match and row statuses in Russian (lists, filters); an unknown status stays visible', () => {
    for (const status of ['linked', 'auto', 'suggested', 'confirmed', 'manual', 'none', 'unchanged']) expect(matchStatusLabel(status), status).toMatch(/[А-Яа-я]/);
    for (const status of ['ok', 'invalid', 'skipped']) expect(rowStatusLabel(status), status).toMatch(/[А-Яа-я]/);
    expect(matchStatusLabel('future')).toBe('future');
    expect(rowStatusLabel('future')).toBe('future');
  });
});

