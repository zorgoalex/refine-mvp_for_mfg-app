import { describe, expect, it } from 'vitest';
import { bazisCutFieldsToRow } from './bazis-xls-writer';
import {
  buildBazisCutPosition,
  mapBazisCutSnapshotFields,
} from './bazis-cut-snapshot-mapper';

// Real source L/W/orientation are extracted from adjacent 1491.xml; expected
// L/W and the remaining export values are independently extracted from 1491.xls.
type GoldenRow = [string, string, number, number, boolean, number, number, number, string, string, string];
const GOLDEN_1491: GoldenRow[] = [
  ['01.00.07', 'К1_Цоколь', 1055, 95, false, 1055, 95, 1, 'Модерн', 'Присадка:', 'Балхаш KZ 10'],
  ['01.00.10', 'К1_ФП', 100, 757, true, 757, 100, 1, 'Модерн', '', ''],
  ['01.00.12', 'К1_ФП', 34, 757, true, 757, 34, 1, 'Модерн', '', ''],
  ['01.00.17', 'К1_Фасад', 595, 753, true, 753, 595, 1, 'Модерн', 'Присадка:', 'Балхаш KZ 10'],
  ['02.00.10', 'К2_Цоколь', 2553, 95, false, 2553, 95, 1, 'Модерн', 'Присадка:', 'Балхаш KZ 10'],
  ['02.01.05', 'К2_Фасад', 613, 185, true, 185, 613, 1, 'Модерн', 'Присадка:', ''],
  ['02.02.04', 'К2_Фасад', 613, 374.5, true, 374.5, 613, 1, 'Модерн', 'Присадка:', ''],
  ['02.03.01', 'К2_Фасад', 613, 185, true, 185, 613, 1, 'Модерн', 'Присадка:', ''],
  ['03.00.06', 'К3_Фасад', 613, 753, true, 753, 613, 1, 'Модерн', 'Присадка:', 'Балхаш KZ 10'],
  ['04.01.06', 'К4_Фасад', 597, 163, true, 163, 597, 1, 'Модерн', 'Присадка:', 'Балхаш KZ 10'],
  ['05.00.02', 'К5_Фасад', 613, 753, true, 753, 613, 1, 'Модерн', 'Присадка:', 'Балхаш KZ 10'],
  ['05.00.03', 'К5_ФП', 566, 857, true, 857, 566, 1, 'Модерн', '', ''],
  ['07.00.05', 'К7_ФП', 100, 1014, true, 1014, 100, 1, 'Модерн', 'Присадка:', ''],
  ['07.00.07', 'К7_Фасад', 410.99, 1011, true, 1011, 410.99, 1, 'Модерн', 'Присадка:', 'AL 31  Белый мат'],
  ['07.00.08', 'К7_Фасад', 410.97, 1011, true, 1011, 410.97, 1, 'Модерн', 'Присадка:', 'AL 31  Белый мат'],
  ['08.00.12', 'К8_Фасад', 597, 1011, true, 1011, 597, 1, 'Модерн', 'Присадка:', 'AL 31  Белый мат'],
  ['09.00.05', 'К9_Фасад', 613, 1011, true, 1011, 613, 1, 'Модерн', 'Присадка:', 'AL 31  Белый мат'],
  ['10.00.05', 'К10_Фасад', 614, 1011, true, 1011, 614, 1, 'Модерн', 'Присадка:', 'AL 31  Белый мат'],
  ['10.00.07', 'К10_ФП', 338, 1014, true, 1014, 338, 1, 'Модерн', '', ''],
  ['11.00.06', 'К11_ФП', 34, 1014, true, 1014, 34, 1, 'Модерн', '', ''],
  ['11.00.08', 'К11_Фасад', 420, 1011, true, 1011, 420, 2, 'Модерн', 'Присадка:', 'AL 31  Белый мат'],
  ['12.00.06', 'К12_Фасад', 304.5, 478, true, 478, 304.5, 2, 'Модерн', 'Присадка:', 'AL 31  Белый мат'],
  ['12.00.07', 'К12_ФП', 338, 481, true, 481, 338, 1, 'Модерн', '', ''],
  ['13.00.01', 'К13_M2_М1_ФП', 1593, 104, true, 104, 1593, 1, 'Модерн', 'Присадка:', ''],
  ['13.00.03', 'К13_M2_М1_ФП', 336, 104, true, 104, 336, 1, 'Модерн', 'Присадка:', ''],
  ['14.00.01', 'К14_M1_М2_ФП', 1217, 104, true, 104, 1217, 1, 'Модерн', 'Присадка:', ''],
  ['14.00.03', 'К14_M1_М2_ФП', 336, 104, true, 104, 336, 1, 'Модерн', 'Присадка:', ''],
  ['14.00.04', 'К14_M1_М2_ФП', 1496, 104, true, 104, 1496, 1, 'Модерн', 'Присадка:', ''],
];

describe('buildBazisCutPosition', () => {
  it.each([
    ['BP-7', 'Кухня', '01.00.07', 'Кухня.01.00.07'],
    ['BP-7', '', '01.00.07', '.01.00.07'],
    ['', 'Кухня', '01.00.07', '.01.00.07'],
    ['', 'Кухня', '', '.'],
    ['', '', '', '.'],
  ])('prepends the product only for a Basis project and always keeps the designation dot',
    (project, product, designation, expected) => {
      expect(buildBazisCutPosition(project, product, designation)).toBe(expected);
  });

  it('trims all input values', () => {
    expect(buildBazisCutPosition(' BP-7 ', ' Кухня ', ' 01.00.07 ')).toBe('Кухня.01.00.07');
  });

  it('does not truncate long source fields', () => {
    expect(buildBazisCutPosition('BP', 'И'.repeat(1500), 'Д'.repeat(1500))).toHaveLength(3001);
  });

  it('does not fall back to the ERP detail number when Basis fields are empty', () => {
    const fields = mapBazisCutSnapshotFields({
      materialName: 'ЛДСП', thicknessMm: 16, detailNumber: 1,
      bazisProject: null,
      basisProduct: null, basisDesignation: null, basisData: null, detailName: 'Бок',
      heightMm: 100, widthMm: 50, quantity: 1, note: null, milling: null, film: null,
      doweling: false, verticalTexture: false,
    });

    expect(fields?.position).toBe('.');
  });
});

describe('1491 snapshot mapper golden', () => {
  it('reproduces all 35 export cells for all 28 positions from real XML source dimensions/orientation', () => {
    const rows = GOLDEN_1491.map(([position, name, sourceLength, sourceWidth, verticalTexture,
      _length, _width, quantity, milling, route, film], index) => {
      const fields = mapBazisCutSnapshotFields({
        materialName: 'МДФ 16 мм', thicknessMm: 16, detailNumber: index + 1,
        bazisProject: '',
        basisProduct: 'Кухня', basisDesignation: position, basisData: null, detailName: name,
        heightMm: sourceLength, widthMm: sourceWidth,
        quantity, note: null, milling, film, doweling: route === 'Присадка:', verticalTexture,
      });
      expect(fields).not.toBeNull();
      return bazisCutFieldsToRow(fields!);
    });
    const expected = GOLDEN_1491.map(([position, name, _sourceLength, _sourceWidth, _vertical,
      length, width, quantity, milling, route, film]) => {
      const computedPosition = `.${position}`;
      return [
      'Да', 'Площадной', 'МДФ 16 мм', '', 16, '', computedPosition, computedPosition, name, length, width,
      Math.round(length * 10) / 10, Math.round(width * 10) / 10, quantity, 'Не задана', '',
      '', '', 0, '', '', 0, '', '', 0, '', '', 0, null, '', '', '', milling, route, film,
      ];
    });

    expect(rows).toHaveLength(28);
    expect(rows.every((row) => row.length === 35)).toBe(true);
    expect(rows).toEqual(expected);
    expect(rows.reduce((sum, row) => sum + Number(row[13]), 0)).toBe(30);
    expect(GOLDEN_1491.filter((row) => row[4])).toHaveLength(26);
    expect(rows.filter((row) => Number(row[9]) < Number(row[10]))).toHaveLength(9);
    expect(rows[0][6]).toBe('.01.00.07');
    expect(rows[0][7]).toBe('.01.00.07');
  });
});
