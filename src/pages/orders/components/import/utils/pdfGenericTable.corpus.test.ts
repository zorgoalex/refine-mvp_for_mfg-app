import fs from 'node:fs';
import path from 'node:path';
// @ts-ignore pdfjs legacy ESM has no matching declaration entry.
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { describe, expect, it } from 'vitest';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import type { PdfTextItem } from '../types/pdfTypes';
import { detectGenericPdfTables, inferredMapping, mapGenericTableRows } from './pdfGenericTable';
import { parsePdfContent } from './pdfTextExtractor';

const corpusDir = '/home/ovhtest/projects/erp_dev/spec_erp/artifacts_test/pdf_Bazis';

function listPdfFiles(directory: string, prefix = ''): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const relativePath = path.join(prefix, entry.name);
    return entry.isDirectory()
      ? listPdfFiles(path.join(directory, entry.name), relativePath)
      : entry.name.toLowerCase().endsWith('.pdf') ? [relativePath] : [];
  });
}

const files = fs.existsSync(corpusDir) ? listPdfFiles(corpusDir).sort() : [];

describe('generic detector Basis corpus', () => {
  if (!files.length) it.skip('corpus unavailable');

  it.each(files)('detects table in %s', async fileName => {
    const data = new Uint8Array(fs.readFileSync(path.join(corpusDir, fileName)));
    const pdf = await pdfjsLib.getDocument({
      data,
      disableWorker: true,
      standardFontDataUrl: path.resolve(process.cwd(), 'node_modules/pdfjs-dist/standard_fonts') + path.sep,
    }).promise;
    const pages: PdfTextItem[][] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const content = await (await pdf.getPage(pageNumber)).getTextContent();
      pages.push(content.items.flatMap((raw): PdfTextItem[] => {
        if (!('str' in raw) || !('transform' in raw) || !raw.str.trim()) return [];
        const item = raw as TextItem;
        return [{
          text: item.str, x: item.transform[4], y: item.transform[5],
          width: item.width, height: item.height, fontName: item.fontName,
        }];
      }));
    }
    const tables = detectGenericPdfTables(pages);
    expect(tables.length).toBeGreaterThan(0);
    expect(tables.every(table => table.rows.length > 0)).toBe(true);
    const expectedQuantity = new Map([
      ['мдф санузел.pdf', 4],
      ['мдф стол.pdf', 9],
      ['мдф шкаф2.pdf', 16],
      [path.join('new', 'Инстал.pdf'), 5],
      [path.join('new', 'МДФ-3.pdf'), 12],
      [path.join('new', 'кухня мдф-1.pdf'), 32],
      [path.join('new', 'мойка.pdf'), 5],
      [path.join('new', 'шкаф.pdf'), 12],
    ]).get(fileName);
    if (expectedQuantity !== undefined) {
      const mappedResults = tables.map(table =>
        mapGenericTableRows(table, inferredMapping(table)));
      const mapped = mappedResults.flatMap(result => result.rows);
      expect(mappedResults.flatMap(result => result.issues)).toEqual([]);
      expect(mapped.reduce((sum, row) => sum + row.quantity, 0)).toBe(expectedQuantity);
    }
    if (fileName === 'мдф санузел.pdf') {
      const parsed = parsePdfContent(pages);
      expect(parsed.metadata).toMatchObject({
        orderNumber: '1494',
        orderName: 'санузел',
        productName: 'санузел',
        totalCount: 4,
      });
    }
  }, 30_000);
});
