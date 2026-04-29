import fs from 'node:fs';
import path from 'node:path';

// pdfjs-dist ships ESM legacy build; Vitest transpiles this test without needing app bundling.
// @ts-ignore
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';

import { convertToImportRows, parsePdfContent } from './pdfTextExtractor';
import type { PdfParsedResult, PdfTextItem } from '../types/pdfTypes';

const PDF_FIXTURE_DIR = process.env.PDF_FIXTURE_DIR || path.resolve(process.cwd(), '../spec_erp');

function item(text: string, x: number, y: number, width = text.length * 5): PdfTextItem {
  return {
    text,
    x,
    y,
    width,
    height: 10,
  };
}

async function parseFixturePdf(fixtureName: string): Promise<PdfParsedResult> {
  const filePath = path.resolve(PDF_FIXTURE_DIR, fixtureName);
  const data = new Uint8Array(fs.readFileSync(filePath));
  const standardFontDataUrl = path.resolve(process.cwd(), 'node_modules/pdfjs-dist/standard_fonts') + path.sep;

  const pdf = await pdfjsLib.getDocument({
    data,
    disableWorker: true,
    standardFontDataUrl,
  }).promise;
  const allPageItems: PdfTextItem[][] = [];

  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();

    allPageItems.push(
      content.items
        .filter((textItem: any) => textItem.str && textItem.str.trim())
        .map((textItem: any) => ({
          text: textItem.str,
          x: textItem.transform[4],
          y: textItem.transform[5],
          width: textItem.width,
          height: textItem.height,
          fontName: textItem.fontName,
        }))
    );
  }

  return parsePdfContent(allPageItems);
}

describe('parsePdfContent table geometry parser', () => {
  it('keeps narrow parts, numeric names, multi-line cells, and multi-dot designations', () => {
    const pageItems: PdfTextItem[] = [
      item('Заказ: № 1338 / кухня', 48, 534),
      item('Материал:', 42, 422.2),
      item('МДФ 16 мм', 105, 422.2),
      item('№', 52, 401.4),
      item('Обозн.', 87, 401.4),
      item('Наименование', 156, 401.4),
      item('Кол-во', 244, 401.4),
      item('Размер, мм', 295, 401.4),
      item('Фрезировка', 404, 401.4),
      item('Пленка', 581, 401.4),
      item('Примечание', 721, 401.4),

      item('400', 289.6, 387.8),
      item('34', 334.4, 387.8),
      item('Модерн', 414, 387.8),
      item('Плёнка мат. OR-01 Магнолия (0,25мм)', 523.2, 387.8),
      item('1', 63, 383),
      item('05.11', 74.3, 383),
      item('планка 50', 167.3, 383),
      item('1', 267, 383),
      item('ADILET', 581, 378.2),

      item('757', 289.6, 365.2),
      item('447', 332, 365.2),
      item('Модерн', 414, 365.2),
      item('Плёнка мат. OR-01 Магнолия (0,25мм)', 523.2, 365.2),
      item('22', 59, 360.4),
      item('17.01.02', 74.3, 360.4),
      item('Фасад', 173.9, 360.4),
      item('1', 267, 360.4),
      item('Присадка:', 726, 360.4),
      item('Лапша', 173.3, 355.6),
      item('ADILET', 581, 355.6),

      item('Общ. кол.', 201, 342),
      item('2', 263, 342),
    ];

    const result = parsePdfContent([pageItems]);

    expect(result.parseErrors).toEqual([]);
    expect(result.stats).toEqual({ positionsCount: 2, totalQuantity: 2 });
    expect(result.details[0]).toMatchObject({
      position: 1,
      designation: '05.11',
      name: 'планка 50',
      quantity: 1,
      length: 400,
      width: 34,
      material: 'МДФ 16 мм',
      milling: 'Модерн',
      film: 'Плёнка мат. OR-01 Магнолия (0,25мм) ADILET',
    });
    expect(result.details[1]).toMatchObject({
      position: 22,
      designation: '17.01.02',
      name: 'Фасад Лапша',
      quantity: 1,
      length: 757,
      width: 447,
      material: 'МДФ 16 мм',
      note: 'Присадка:',
    });
  });

  it('sums multiple total-count lines from multi-section PDFs', () => {
    const pageOne: PdfTextItem[] = [
      item('Материал:', 42, 422.2),
      item('МДФ 18 мм', 105, 422.2),
      item('№', 52, 401.4),
      item('Обозн.', 87, 401.4),
      item('Наименование', 156, 401.4),
      item('Кол-во', 244, 401.4),
      item('Размер, мм', 295, 401.4),
      item('Фрезировка', 404, 401.4),
      item('Пленка', 581, 401.4),
      item('Примечание', 721, 401.4),
      item('1', 63, 383),
      item('06.12', 74.3, 383),
      item('Планка', 167.3, 383),
      item('1', 267, 383),
      item('1343', 289.6, 387.8),
      item('95', 334.4, 387.8),
      item('С', 56, 360),
      item('Общ. кол.', 202, 360),
      item('1', 264, 360),
    ];
    const pageTwo: PdfTextItem[] = [
      item('Материал:', 42, 422.2),
      item('МДФ 16 мм', 105, 422.2),
      item('№', 52, 401.4),
      item('Обозн.', 87, 401.4),
      item('Наименование', 156, 401.4),
      item('Кол-во', 244, 401.4),
      item('Размер, мм', 295, 401.4),
      item('Фрезировка', 404, 401.4),
      item('Пленка', 581, 401.4),
      item('Примечание', 721, 401.4),
      item('1', 63, 383),
      item('01.04', 74.3, 383),
      item('Фасад', 173.9, 387.8),
      item('2', 267, 383),
      item('488', 289.6, 387.8),
      item('597', 332, 387.8),
      item('Лапша', 173.3, 378.2),
      item('С', 56, 360),
      item('Общ. кол.', 202, 360),
      item('2', 264, 360),
    ];

    const result = parsePdfContent([pageOne, pageTwo]);

    expect(result.parseErrors).toEqual([]);
    expect(result.metadata.material).toBe('МДФ 18 мм, МДФ 16 мм');
    expect(result.metadata.totalCount).toBe(3);
    expect(result.stats).toEqual({ positionsCount: 2, totalQuantity: 3 });
    expect(result.details.map(detail => detail.material)).toEqual(['МДФ 18 мм', 'МДФ 16 мм']);
    expect(convertToImportRows(result).map(row => row.materialName)).toEqual(['МДФ 18 мм', 'МДФ 16 мм']);
  });
});

describe('parsePdfContent PDF fixtures', () => {
  const fixtureCases = [
    { fixture: 'mdf_ex1.pdf', positionsCount: 4, totalQuantity: 4, expectedTotalCount: 4 },
    { fixture: 'mdf_ex2.pdf', positionsCount: 33, totalQuantity: 39, expectedTotalCount: 39 },
    { fixture: 'mdf_wrong.pdf', positionsCount: 9, totalQuantity: 14, expectedTotalCount: 14 },
    { fixture: 'mdf_wrong2.pdf', positionsCount: 45, totalQuantity: 48, expectedTotalCount: 48 },
    { fixture: 'mdf_wrong3.pdf', positionsCount: 38, totalQuantity: 39, expectedTotalCount: 39 },
    { fixture: 'mdf_wrong4.pdf', positionsCount: 32, totalQuantity: 36, expectedTotalCount: 36 },
  ];
  const availableFixtureCases = fixtureCases.filter(({ fixture }) => fs.existsSync(path.resolve(PDF_FIXTURE_DIR, fixture)));
  const hasAllTrickyFixtures = ['mdf_ex2.pdf', 'mdf_wrong.pdf', 'mdf_wrong2.pdf'].every(fixture =>
    fs.existsSync(path.resolve(PDF_FIXTURE_DIR, fixture))
  );

  if (availableFixtureCases.length === 0) {
    it.skip(`skips real PDF fixture checks because PDF_FIXTURE_DIR does not contain mdf_*.pdf files`);
  }

  it.each(availableFixtureCases)(
    'parses $fixture without total-count mismatch',
    async ({ fixture, positionsCount, totalQuantity, expectedTotalCount }) => {
      const result = await parseFixturePdf(fixture);

      expect(result.parseErrors).toEqual([]);
      expect(result.metadata.totalCount).toBe(expectedTotalCount);
      expect(result.stats).toEqual({ positionsCount, totalQuantity });
    },
    30_000
  );

  (hasAllTrickyFixtures ? it : it.skip)('parses representative tricky rows from real PDFs', async () => {
    const ex2 = await parseFixturePdf('mdf_ex2.pdf');
    expect(ex2.details.find(detail => detail.position === 1)).toMatchObject({
      designation: '05.11',
      name: 'планка 50',
      quantity: 1,
      length: 400,
      width: 34,
    });
    expect(ex2.details.find(detail => detail.position === 22)).toMatchObject({
      designation: '17.01.02',
      name: 'Фасад Лапша',
      length: 757,
      width: 447,
    });

    const wrong = await parseFixturePdf('mdf_wrong.pdf');
    expect(wrong.details[0]).toMatchObject({
      designation: '01.04',
      name: 'Фасад Лапша',
      length: 2132,
      width: 460,
      milling: 'Выборка',
    });
    expect(wrong.details[0].film).toContain('SAFA');

    const wrong2 = await parseFixturePdf('mdf_wrong2.pdf');
    expect(wrong2.details[0]).toMatchObject({
      designation: '06.12',
      name: 'Планка',
      quantity: 1,
      length: 1343,
      width: 95,
      material: 'МДФ 18 мм',
    });
    expect(wrong2.metadata.material).toBe('МДФ 18 мм, МДФ 16 мм');
    expect(wrong2.metadata.totalCount).toBe(48);
    const firstMdf16Index = wrong2.details.findIndex(detail => detail.material === 'МДФ 16 мм');
    expect(firstMdf16Index).toBeGreaterThan(0);
    expect(wrong2.details.slice(0, firstMdf16Index).every(detail => detail.material === 'МДФ 18 мм')).toBe(true);
    expect(wrong2.details.slice(firstMdf16Index).every(detail => detail.material === 'МДФ 16 мм')).toBe(true);

    const wrong2Rows = convertToImportRows(wrong2);
    expect(wrong2Rows[0].materialName).toBe('МДФ 18 мм');
    expect(wrong2Rows[firstMdf16Index].materialName).toBe('МДФ 16 мм');
  }, 30_000);
});
