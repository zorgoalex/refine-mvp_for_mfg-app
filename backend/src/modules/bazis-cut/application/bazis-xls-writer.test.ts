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
    expect(sheet['!ref']).toBe('A1:AI2');
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null });
    expect(rows[0]).toEqual([...BAZIS_CUT_HEADERS]);
    expect(rows[1]?.[5]).toBe('1319');
    expect(rows[1]?.[6]).toBe('Кухня');
    expect(rows[1]?.[7]).toBe('1319Кухня.01.00.07');
    expect(rows[1]?.[4]).toBe(18);
    expect(rows[1]?.[28]).toBeNull();
    expect(rows[1]?.[29]).toBe('=literal');
    expect(sheet.AD2?.f).toBeUndefined();
  });

  it('rejects an empty set', () => {
    expect(() => buildBazisCutXls([])).toThrow('Нельзя экспортировать пустой набор');
  });

  it.each([
    ['', '', '01.00.07'],
    ['1319', '', '1319.01.00.07'],
    ['', 'Кухня', 'Кухня.01.00.07'],
  ])('omits missing order/product values from position', (order, product, expected) => {
    const bytes = buildBazisCutXls([detail({
      sourceBazisOrderNo: order,
      sourceBazisProductName: product,
      position: '01.00.07',
    })]);
    const workbook = XLSX.read(bytes, { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json<unknown[]>(
      workbook.Sheets[BAZIS_CUT_SHEET_NAME],
      { header: 1, defval: null },
    );

    expect(rows[1]?.[5]).toBe(order);
    expect(rows[1]?.[6]).toBe(product);
    expect(rows[1]?.[7]).toBe(expected);
  });
});

function detail(overrides: Partial<BazisCutSetDetailDto> = {}): BazisCutSetDetailDto {
  return {
    bazisCutSetDetailId: 1, bazisCutSetId: 1, sortOrder: 0,
    sourceOrderDetailId: 7, sourceOrderId: 14, sourceProjectId: 3,
    sourceBazisProjectId: 2, sourceBazisRevisionId: 4, sourceBazisNodeId: 5,
    sourceOrderName: '1491', sourceOrderFullNumber: 'МП-1-1491', sourceProjectCode: 'МП-1',
    sourceBazisProjectName: '1319', sourceBazisOrderNo: '1319', sourceBazisProductName: 'Кухня',
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
