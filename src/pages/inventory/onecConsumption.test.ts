import { describe, expect, it } from 'vitest';
import { preferredWarehouseIds } from './filmStock';
import { documentBasis, onecIssueDocument, onecIssueLabel, onecRunText, sameMoment, supportsOnecConsumption } from './onecConsumption';

describe('1C consumption screen helpers', () => {
  it('names the 1C document and the reason in Russian, keeping unknown codes visible', () => {
    expect(onecIssueDocument({ docKind: 'sales_shipment', docNumber: '15', docDate: '2026-09-28', onecDocumentId: 7 })).toBe('Реализация № 15 от 28.09.2026');
    expect(onecIssueDocument({ docKind: null, docNumber: null, docDate: null, onecDocumentId: 7 })).toBe('Документ 1С (id 7)');
    expect(onecIssueLabel('FILM_UNLINKED')).toBe('Позиция 1С не связана с плёнкой');
    expect(onecIssueLabel('NEW_CODE')).toBe('NEW_CODE');
  });

  it('explains a manual pass outcome', () => {
    expect(onecRunText({ status: 'skipped', reason: 'disabled' })).toEqual({ tone: 'warning', text: 'Расход из 1С выключен на сервере' });
    expect(onecRunText({ status: 'done', candidates: 4, processed: 2, documents: 1, failed: 0 }).tone).toBe('success');
    expect(onecRunText({ status: 'done', candidates: 4, processed: 2, documents: 1, failed: 1 }).text).toContain('с ошибкой 1');
  });

  it('detects backend support by the presence of the field, not its value', () => {
    expect(supportsOnecConsumption({ onecConsumptionSince: null })).toBe(true);
    expect(supportsOnecConsumption({})).toBe(false);
  });

  it('compares moments across ISO spellings', () => {
    expect(sameMoment('2026-09-26T05:14:55.000Z', '2026-09-26T10:14:55+05:00')).toBe(true);
    expect(sameMoment(null, undefined)).toBe(true);
    expect(sameMoment(null, '2026-09-26T05:14:55Z')).toBe(false);
  });

  it('shows the 1C document as the basis of a projection document', () => {
    expect(documentBasis({ source: 'onec', comment: '1С: Реализация № 1 от 26.09.2026', fileName: null })).toBe('1С: Реализация № 1 от 26.09.2026');
    expect(documentBasis({ source: 'import', comment: null, fileName: 'остатки.xlsx' })).toBe('остатки.xlsx');
    expect(documentBasis({ source: 'manual', comment: null, fileName: null })).toBe('—');
  });

  it('opens the film warehouse by default: consumption from 1C first, then film stock, then the rest by name', () => {
    expect(preferredWarehouseIds([
      { warehouseId: 8, onecConsumptionSince: null, filmsWithStock: 0 },
      { warehouseId: 3, onecConsumptionSince: null, filmsWithStock: 4 },
      { warehouseId: 2, onecConsumptionSince: '2026-09-26T05:14:00Z', filmsWithStock: 70 },
      { warehouseId: 5, onecConsumptionSince: undefined, filmsWithStock: 0 },
    ])).toEqual([2, 3, 8, 5]);
  });
});
