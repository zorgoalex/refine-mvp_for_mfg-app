import { describe, expect, it } from 'vitest';
import type { SheetMaterialTypeDto } from '../../api/sheetMaterialsApi';
import type { WarehouseStockDto, WarehouseStockItemDto } from '../../api/types/inventoryApi.types';
import {
  canLinkRow, isStockUnsupported, linkDecision, linkInput, nextStockSupport, onecNotices, pageTitle, resolveGroup, stockExportRows, stockTabs,
} from './warehouseStock';

const data = (tabs: WarehouseStockDto['tabs']): WarehouseStockDto => ({
  warehouseId: 2, warehouseName: 'Склад фрезеровки', tabs, categories: [], total: 0, items: [],
  onec: { available: true, reason: null, onecWarehouseName: 'Склад фрезировки', snapshotVersion: '2026-09-30T16:53:05.736Z', rejectedReason: null, completeness: 'verified', directoriesRevoked: false },
});
const row = (over: Partial<WarehouseStockItemDto>): WarehouseStockItemDto => ({
  source: '1c', group: 'unlinked', groupLabel: 'Не сопоставлено с ERP', filmId: null, itemRefKey: 'ba1649b1-e9fd-11f0-98ec-18c04dfda411',
  code: 'НФ-1', name: 'МДФ 10 мм', vendorName: null, categoryKey: null, categoryName: 'Раходные материалы', unitName: 'л.',
  quantity: 4.352, sheetMaterialTypeId: null, ambiguousLink: false, ...over,
});
const sheet: SheetMaterialTypeDto = {
  sheetMaterialTypeId: 1, name: 'МДФ 10мм', materialTypeId: 1, unitId: 3, thicknessMm: 10, widthMm: 2800, heightMm: 2070,
  supplierId: null, vendorId: 4, supplierArticle: null, texture: null, color: 'белый', refKey1c: null, isActive: true,
  isCuttable: true, sortOrder: 5, version: 7,
};

describe('warehouse stock screen helpers', () => {
  it('titles the page by the selected warehouse', () => {
    expect(pageTitle('Склад фрезеровки')).toBe('Остатки · Склад фрезеровки');
    expect(pageTitle(undefined)).toBe('Остатки на складах');
  });

  it('builds tabs with counts; an old backend (404 other than a missing warehouse) leaves only the film tab', () => {
    const tabs = [{ key: 'all', label: 'Все материалы', count: 7 }, { key: 'film', label: 'Плёнка', count: 3 }, { key: 'material:1', label: 'МДФ', count: 4 }];
    expect(stockTabs(data(tabs), false).map((tab) => tab.label)).toEqual(['Все материалы · 7', 'Плёнка · 3', 'МДФ · 4']);
    expect(isStockUnsupported({ status: 404, code: 'NOT_FOUND' })).toBe(true);
    expect(isStockUnsupported({ statusCode: 404, code: 'WAREHOUSE_NOT_FOUND' })).toBe(false);
    expect(isStockUnsupported({ status: 500 })).toBe(false);
    expect(stockTabs(undefined, true)).toEqual([{ key: 'film', label: 'Плёнка' }]);
    expect(resolveGroup('material:1', data(tabs), true)).toBe('film');
  });

  it('keeps «unsupported» once seen: later requests without an error do not bring the 1C tabs back (no request loop)', () => {
    let unsupported = false;
    for (const error of [{ status: 404, code: 'NOT_FOUND' }, null, undefined, { status: 500 }]) unsupported = nextStockSupport(unsupported, error);
    expect(unsupported).toBe(true);
    expect(resolveGroup('all', undefined, unsupported)).toBe('film');
    expect(nextStockSupport(false, { status: 404, code: 'WAREHOUSE_NOT_FOUND' })).toBe(false);
  });

  it('falls back to «all» when the stored tab disappeared', () => {
    const tabs = [{ key: 'all', label: 'Все материалы', count: 1 }, { key: 'film', label: 'Плёнка', count: 1 }];
    expect(resolveGroup('material:9', data(tabs), false)).toBe('all');
    expect(resolveGroup('film', data(tabs), false)).toBe('film');
    expect(resolveGroup(undefined, undefined, false)).toBe('all');
  });

  it('explains why 1C stock is missing and warns about rejected/incomplete snapshots', () => {
    const base = data([]).onec;
    expect(onecNotices({ ...base, available: false, reason: 'ambiguous_source' })[0]).toMatchObject({ type: 'warning', message: expect.stringContaining('нескольких базах 1С') });
    expect(onecNotices(base)).toEqual([{ type: 'info', message: expect.stringContaining('склад 1С «Склад фрезировки»') }]);
    const warned = onecNotices({ ...base, rejectedReason: 'rows_mismatch', completeness: 'partial', directoriesRevoked: true });
    expect(warned.map((notice) => notice.type)).toEqual(['info', 'warning', 'warning', 'warning']);
  });

  it('offers linking only for unlinked 1C rows', () => {
    expect(canLinkRow(row({}))).toBe(true);
    expect(canLinkRow(row({ group: 'no_type', sheetMaterialTypeId: 3 }))).toBe(false);
    expect(canLinkRow(row({ group: 'material:1' }))).toBe(false);
    expect(canLinkRow(row({ source: 'erp', itemRefKey: null, group: 'film' }))).toBe(false);
  });

  it('decides the link from the FRESH record: empty key, same key, another key (replace), inactive', () => {
    const key = 'BA1649B1-E9FD-11F0-98EC-18C04DFDA411';
    expect(linkDecision({ isActive: true, refKey1c: null }, key)).toEqual({ kind: 'link' });
    expect(linkDecision({ isActive: true, refKey1c: key.toLowerCase() }, key)).toEqual({ kind: 'already' });
    // Ключ сменили между выбором и чтением — решение по свежей записи требует подтверждения замены.
    expect(linkDecision({ isActive: true, refKey1c: '6325798a-6fde-11ee-84da-94de808e1036' }, key)).toEqual({ kind: 'confirm_replace', currentKey: '6325798a-6fde-11ee-84da-94de808e1036' });
    expect(linkDecision({ isActive: false, refKey1c: null }, key)).toEqual({ kind: 'inactive' });
  });

  it('keeps every field of the sheet material and sets only the 1C key', () => {
    const { version: _version, sheetMaterialTypeId: _id, ...fields } = sheet;
    expect(linkInput(sheet, 'BA1649B1-E9FD-11F0-98EC-18C04DFDA411')).toEqual({ ...fields, refKey1c: 'ba1649b1-e9fd-11f0-98ec-18c04dfda411' });
  });

  it('exports the current tab with source and unit', () => {
    expect(stockExportRows([row({}), row({ source: 'erp', group: 'film', groupLabel: 'Плёнка', itemRefKey: null, code: null, name: 'Айвори; Алер', vendorName: 'Алер', categoryName: null, unitName: 'пог. м', quantity: 12.5 })]))
      .toEqual([
        { Вкладка: 'Не сопоставлено с ERP', Наименование: 'МДФ 10 мм', 'Код 1С': 'НФ-1', 'Поставщик / категория 1С': 'Раходные материалы', Остаток: 4.352, 'Ед.': 'л.', Источник: '1С' },
        { Вкладка: 'Плёнка', Наименование: 'Айвори; Алер', 'Код 1С': '', 'Поставщик / категория 1С': 'Алер', Остаток: 12.5, 'Ед.': 'пог. м', Источник: 'ERP' },
      ]);
  });
});
