import { describe, expect, it } from 'vitest';
import { convertToImportRows, splitBasisProjectReference } from './pdfTextExtractor';
import type { PdfParsedResult } from '../types/pdfTypes';

// Fixture-free unit test for the Basis PDF → import-row mapping. The full
// parse-a-real-PDF test lives in pdfTextExtractor.test.ts and depends on a
// binary fixture that is not present in every environment.
function makeResult(details: PdfParsedResult['details']): PdfParsedResult {
  return {
    metadata: { orderNumber: '1057', orderName: 'Кухня', material: 'МДФ 16 мм' },
    stats: { positionsCount: details.length, totalQuantity: details.length },
    details,
    pages: 1,
    parseErrors: [],
  };
}

describe('convertToImportRows Basis field split', () => {
  it.each([
    ['1319Прихожка', { basisProject: '1319', basisProduct: 'Прихожка' }],
    ['1319Сан.узел', { basisProject: '1319', basisProduct: 'Сан.узел' }],
    ['1319Шкаф 2', { basisProject: '1319', basisProduct: 'Шкаф 2' }],
    ['1319 / Шкаф 2', { basisProject: '1319', basisProduct: 'Шкаф 2' }],
    ['1319', { basisProject: '1319', basisProduct: null }],
    ['Шкаф 2', { basisProject: null, basisProduct: 'Шкаф 2' }],
    ['', { basisProject: null, basisProduct: null }],
  ])('splits project reference %j', (value, expected) => {
    expect(splitBasisProjectReference(value)).toEqual(expected);
  });

  it('maps "Обозн." to basisDesignation and "Наименование" to detailName only', () => {
    const rows = convertToImportRows(
      makeResult([
        { designation: '11.02', name: 'Бок L', position: 1, quantity: 2, length: 700, width: 300 },
      ]),
    );

    expect(rows[0]).toMatchObject({
      basisDesignation: '11.02',
      detailName: 'Бок L',
      basisData: '1/11.02/Бок L',
      basisProject: '№ 1057 / Кухня',
      basisProduct: null,
    });
    // The packed "position~~designation~~name" form must be gone.
    expect(rows[0].detailName).not.toContain('~~');
  });

  it('maps the non-numeric product suffix only from the "Обозн. проект" column', () => {
    const rows = convertToImportRows(
      makeResult([
        {
          projectReference: '1319Прихожка',
          projectReferenceSource: 'project_designation',
          designation: '11.02',
          name: 'Бок L',
          position: 1,
          quantity: 1,
          length: 700,
          width: 300,
        },
        {
          projectReference: '1319Прихожка',
          projectReferenceSource: 'order_number',
          designation: '11.03',
          name: 'Бок R',
          position: 2,
          quantity: 1,
          length: 700,
          width: 300,
        },
      ]),
    );

    expect(rows[0]).toMatchObject({ basisProject: '1319', basisProduct: 'Прихожка' });
    expect(rows[1]).toMatchObject({ basisProject: '1319', basisProduct: null });
  });

  it.each([
    ['Присадка:', true],
    ['присадка', true],
    ['ПРИСАДКА + черновой', true],
    ['Черновой', false],
    ['', false],
    [undefined, false],
  ])('sets doweling from note %j → %s', (note, expected) => {
    const rows = convertToImportRows(
      makeResult([
        { designation: '11.02', name: 'Бок L', position: 1, quantity: 1, length: 700, width: 300, note },
      ]),
    );
    expect(rows[0].doweling).toBe(expected);
    // Примечание при этом сохраняется как есть (флаг его не заменяет).
    expect(rows[0].note ?? null).toBe(note || null);
  });

  it('leaves detailName null when Наименование is empty', () => {
    const rows = convertToImportRows(
      makeResult([
        { designation: '36', name: '', position: 3, quantity: 1, length: 500, width: 400 },
      ]),
    );
    expect(rows[0].basisDesignation).toBe('36');
    expect(rows[0].detailName).toBeNull();
  });
});
