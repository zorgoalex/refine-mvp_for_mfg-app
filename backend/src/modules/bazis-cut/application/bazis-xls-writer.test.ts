import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { BAZIS_CUT_HEADERS, BAZIS_CUT_SHEET_NAME, buildBazisCutXls } from './bazis-xls-writer';
import type { BazisCutSetDetailDto } from '../dto/bazis-cut.dto';

describe('buildBazisCutXls', () => {
  it('writes a real BIFF8 workbook with exact columns and typed cells', () => {
    const bytes = buildBazisCutXls([detail({ position: '01.00.07', comment: '=literal', priority: null })]);

    expect(bytes.subarray(0, 8).toString('hex')).toBe('d0cf11e0a1b11ae1');
    expect(bytes.subarray(0, 2).toString('hex')).not.toBe('504b');

    const workbook = XLSX.read(bytes, { type: 'buffer', cellFormula: true });
    expect(workbook.SheetNames).toEqual([BAZIS_CUT_SHEET_NAME]);
    const sheet = workbook.Sheets[BAZIS_CUT_SHEET_NAME];
    expect(sheet['!ref']).toBe('A1:AK2');
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null });
    expect(rows[0]).toEqual([...BAZIS_CUT_HEADERS]);
    expect(BAZIS_CUT_HEADERS.indexOf('Изделие')).toBe(BAZIS_CUT_HEADERS.indexOf('Заказ') + 1);
    expect(BAZIS_CUT_HEADERS.indexOf('Ванна')).toBe(BAZIS_CUT_HEADERS.indexOf('%Пленка') - 1);
    expect(rows[1]?.[5]).toBe('BZ-100');
    expect(rows[1]?.[6]).toBe('Кухня');
    expect(rows[1]?.[7]).toBe('BZ-10001.00.07');
    expect(rows[1]?.[8]).toBe('BP-701.00.07');
    expect(rows[1]?.[4]).toBe(18);
    expect(rows[1]?.[29]).toBeNull();
    expect(rows[1]?.[30]).toBe('=literal');
    expect(rows[1]?.[35]).toBe('28-2');
    expect(sheet.AE2?.f).toBeUndefined();
  });

  it('rejects an empty set', () => {
    expect(() => buildBazisCutXls([])).toThrow('Нельзя экспортировать пустой набор');
  });

  it.each([
    ['', 'BZ-100', '.01.00.07', 'BZ-100.01.00.07', '.01.00.07'],
    ['BP-7', '', 'Кухня.01.00.07', 'Кухня.01.00.07', 'BP-7Кухня.01.00.07'],
    ['', '', 'ERP-1491.7', 'ERP-1491.7', 'ERP-1491.7'],
  ])('copies Basis order into Excel Order and prefixes Excel Position with that same value',
    (project, order, position, expectedPosition, expectedQrCode) => {
    const bytes = buildBazisCutXls([detail({
      sourceBazisProjectName: project,
      sourceBazisOrderNo: order,
      position,
    })]);
    const workbook = XLSX.read(bytes, { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json<unknown[]>(
      workbook.Sheets[BAZIS_CUT_SHEET_NAME],
      { header: 1, defval: null },
    );

    expect(rows[1]?.[5]).toBe(order);
    expect(rows[1]?.[6]).toBe('Кухня');
    expect(rows[1]?.[7]).toBe(expectedPosition);
    expect(rows[1]?.[8]).toBe(expectedQrCode);
  });
});

function detail(overrides: Partial<BazisCutSetDetailDto> = {}): BazisCutSetDetailDto {
  return {
    bazisCutSetDetailId: 1, bazisCutSetId: 1, sortOrder: 0,
    sourceOrderDetailId: 7, sourceOrderId: 14, sourceOrderDeleted: false, sourceProjectId: 3,
    sourceBazisProjectId: 2, sourceBazisRevisionId: 4, sourceBazisNodeId: 5,
    sourceOrderName: '1491', sourceOrderFullNumber: 'МП-1-1491', sourceProjectCode: 'МП-1',
    sourceBazisProjectName: 'BP-7', sourceBazisOrderNo: 'BZ-100', sourceBazisProductName: 'Кухня',
    sourceBathCutNumber: '28-2',
    cutEnabled: true, materialType: 'Площадной', materialName: 'ЛДСП Белый', materialArticle: '',
    thicknessMm: 18, position: '01.00.01', partName: 'Панель', finishedLengthMm: 410.99,
    finishedWidthMm: 374.5, cutLengthMm: 411, cutWidthMm: 374.5, quantity: 2,
    orientation: 'Не задана', groove: '', l1Name: '', l1Designation: '', l1ThicknessMm: 0,
    l2Name: '', l2Designation: '', l2ThicknessMm: 0, w1Name: '', w1Designation: '',
    w1ThicknessMm: 0, w2Name: '', w2Designation: '', w2ThicknessMm: 0, priority: null,
    comment: '', customProperty: '', glue: '', milling: 'Модерн', route: 'Присадка:',
    film: 'Белый мат', createdAt: '2026-07-15T00:00:00.000Z', updatedAt: '2026-07-15T00:00:00.000Z',
    ...overrides,
  };
}
