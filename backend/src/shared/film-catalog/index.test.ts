import { describe, expect, it } from 'vitest';
import {
  buildTargetName,
  catalogKeyOf,
  detectCatalogHeader,
  extractCatalogRows,
  normalizeUnit,
  parseCatalogDescription,
  validateCatalogRows,
} from './index';

const HEADER = ['Наименование материала Оригинал', 'Наименование материала и Поставщик', 'ТипНоменклатуры', 'ЕдиницаИзмерения', 'КатегорияНоменклатуры', 'Поставщик'];

describe('film catalog rows', () => {
  it('detects the 1C catalog header and ignores unrelated sheets', () => {
    expect(detectCatalogHeader([HEADER])).toEqual({
      headerRowIndex: 0,
      columns: { nameOriginal: 0, nameFull: 1, nomenclatureType: 2, unit: 3, nomenclatureCategory: 4, supplier: 5 },
    });
    expect(detectCatalogHeader([['Производитель'], ['kira']])).toBeNull();
    expect(detectCatalogHeader([['title'], [], ['поставщик', ' наименование материала и поставщик ', 'Наименование материала оригинал']])?.headerRowIndex).toBe(2);
  });

  it('extracts rows with collapsed whitespace and skips empty lines', () => {
    const rows = [HEADER,
      ['Белый Снег', 'Белый Снег ; Алимжан AIF Текстурная', 'Запас', 'пог. м', 'ПЛЕНКА ПВХ ДЛЯ МДФ', 'Алимжан AIF'],
      [null, '', null, null, null, ''],
      ['AL-11  Небесно-синий', 'AL-11  Небесно-синий ; Алер Текстурная', 'Запас', 'пог. м', 'ПЛЕНКА ПВХ ДЛЯ МДФ', 'Алер']];
    const extracted = extractCatalogRows(rows, detectCatalogHeader(rows)!);
    expect(extracted).toHaveLength(2);
    expect(extracted[1]).toMatchObject({ rowNo: 4, nameOriginal: 'AL-11 Небесно-синий', supplier: 'Алер', unit: 'пог. м' });
  });

  it('builds the target name «Наименование; Поставщик» and a whitespace-insensitive key', () => {
    expect(buildTargetName('Светло-Кремовый ', 'FocusPrime')).toBe('Светло-Кремовый; FocusPrime');
    expect(catalogKeyOf('AL-11  Небесно-синий ; Алер Текстурная')).toBe('al-11 небесно-синий ; алер текстурная');
  });

  it('parses 1C descriptions: last «;» splits name and supplier, «Текстурная» is dropped', () => {
    expect(parseCatalogDescription('Белый Снег ; Алимжан AIF Текстурная')).toEqual({ nameOriginal: 'Белый Снег', supplier: 'Алимжан AIF' });
    expect(parseCatalogDescription('Моно айс (0,27 ) пленка D166-34 ; МС-ГРУП')).toEqual({ nameOriginal: 'Моно айс (0,27 ) пленка D166-34', supplier: 'МС-ГРУП' });
    expect(parseCatalogDescription('Дуб патина грэй ARC 722-2-L_0.25*1400, пог. м ; Евразия Декор')?.supplier).toBe('Евразия Декор');
    expect(parseCatalogDescription('Белый Снег')).toBeNull();
    expect(parseCatalogDescription(' ; Алер')).toBeNull();
  });

  it('keeps invalid rows with a reason: duplicates, missing supplier, too long names', () => {
    const rows = validateCatalogRows([
      { rowNo: 2, nameOriginal: 'Софт Грей', nameFull: 'Софт Грей ; Алимжан AIF Текстурная', supplier: 'Алимжан AIF', nomenclatureType: 'Запас', unit: 'пог. м', nomenclatureCategory: 'ПЛЕНКА ПВХ ДЛЯ МДФ' },
      { rowNo: 3, nameOriginal: 'Софт Грей', nameFull: 'Софт  Грей ; Алимжан AIF Текстурная', supplier: 'Алимжан AIF', nomenclatureType: null, unit: null, nomenclatureCategory: null },
      { rowNo: 4, nameOriginal: 'Белый Снег', nameFull: 'Белый Снег', supplier: '', nomenclatureType: null, unit: null, nomenclatureCategory: null },
      { rowNo: 5, nameOriginal: 'x'.repeat(200), nameFull: 'y', supplier: 'Алер', nomenclatureType: null, unit: null, nomenclatureCategory: null },
    ]);
    expect(rows.map((r) => r.rowStatus)).toEqual(['ok', 'invalid', 'invalid', 'invalid']);
    expect(rows[0].targetName).toBe('Софт Грей; Алимжан AIF');
    expect(rows[1].issue).toBe('Повтор строки каталога');
    expect(rows[2].issue).toBe('Не указан поставщик');
    expect(rows[3].issue).toContain('длиннее 200');
  });

  it('normalizes units for comparison', () => {
    expect(normalizeUnit('пог. м')).toBe('пог м');
    expect(normalizeUnit('ПОГ.М')).toBe('пог м');
    expect(normalizeUnit(null)).toBe('');
  });
});
