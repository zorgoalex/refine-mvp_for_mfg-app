import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { PdfGenericTable } from './pdfGenericTable';
import {
  applyPdfSectionMaterialOverrides,
  collectPdfSectionMaterials,
  pdfSectionMaterialKey,
  resolvePdfSectionMaterialId,
} from './pdfSectionMaterialMapping';

const table = (
  id: string,
  pageNumber: number,
  sectionMaterialName: string | undefined,
  rowCount: number,
): PdfGenericTable => ({
  id,
  pageNumber,
  sectionMaterialName,
  columns: [],
  rows: Array.from({ length: rowCount }, () => []),
  unresolvedLines: [],
  signature: {
    fingerprintVersion: 1,
    parserMajor: 1,
    headerBandCount: 1,
    columns: [],
  },
});

const sheetMaterialTypes = [
  { id: 10, name: 'МДФ 16мм', isCuttable: true },
  { id: 20, name: 'МДФ 18мм', isCuttable: true },
  { id: 30, name: 'Не раскраивается', isCuttable: false },
];

describe('PDF section material mapping', () => {
  it('groups the same section material and keeps page/row context', () => {
    expect(collectPdfSectionMaterials([
      table('p1', 1, 'МДФ 16 мм', 2),
      table('p2', 2, ' мдф 16 мм ', 3),
      table('p3', 3, 'МДФ 18 мм', 1),
      table('p4', 4, undefined, 4),
    ])).toEqual([
      { sourceName: 'МДФ 16 мм', pageNumbers: [1, 2], rowCount: 5 },
      { sourceName: 'МДФ 18 мм', pageNumbers: [3], rowCount: 1 },
    ]);
  });

  it('shows automatic resolution and lets a current-import override win', () => {
    expect(resolvePdfSectionMaterialId('МДФ 16 мм', {}, sheetMaterialTypes)).toBe(10);
    expect(resolvePdfSectionMaterialId(
      'МДФ 16 мм',
      { [pdfSectionMaterialKey('МДФ 16 мм')]: 20 },
      sheetMaterialTypes,
    )).toBe(20);
  });

  it('applies only explicit current-import overrides to parsed rows', () => {
    const rows = [
      { sourceRowIndex: 0, materialName: 'МДФ 16 мм' },
      { sourceRowIndex: 1, materialName: 'МДФ 18 мм' },
      { sourceRowIndex: 2, materialName: null },
    ];
    expect(applyPdfSectionMaterialOverrides(
      rows,
      { [pdfSectionMaterialKey('МДФ 16 мм')]: 20 },
      sheetMaterialTypes,
    )).toEqual([
      { sourceRowIndex: 0, materialName: 'МДФ 18мм' },
      { sourceRowIndex: 1, materialName: 'МДФ 18 мм' },
      { sourceRowIndex: 2, materialName: null },
    ]);
  });

  it('keeps the mapping UI wired without persisting document material in the layout', () => {
    const stepSource = readFileSync(
      new URL('../steps/PdfLayoutMappingStep.tsx', import.meta.url),
      'utf8',
    );
    const modalSource = readFileSync(
      new URL('../PdfImportModal.tsx', import.meta.url),
      'utf8',
    );

    expect(stepSource).toContain('Материалы секций');
    expect(stepSource).toContain('onSectionMaterialMappingChange');
    expect(modalSource).toContain('applyPdfSectionMaterialOverrides');
    expect(modalSource).toContain('sectionMaterialOverrides');
  });
});
