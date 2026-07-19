import type { ImportRow } from '../types/importTypes';
import type { PdfTextItem } from '../types/pdfTypes';
import { groupTextItemsIntoLines, isHeaderOrFooter } from './pdfTextExtractor';
import type { PdfLayoutMapping, PdfLayoutSignature, PdfLayoutTarget } from './pdfLayoutPattern';

export interface PdfGenericColumn {
  header: string;
  minX: number;
  maxX: number;
  inferredTarget: PdfLayoutTarget;
}

export interface PdfGenericTable {
  id: string;
  pageNumber: number;
  columns: PdfGenericColumn[];
  rows: string[][];
  geometryCandidateCells?: string[];
  unresolvedLines: string[][];
  signature: PdfLayoutSignature;
}

export type PdfUnresolvedLineAction =
  | { kind: 'ignore' }
  | { kind: 'row' }
  | { kind: 'attach'; rowIndex: number };

const HEADER_ALIASES: Array<[RegExp, PdfLayoutTarget]> = [
  [/^№$|пози/i, 'position'],
  [/обозн.*проект|№\s*заказ/i, 'basis_project'],
  [/изделие|продукт/i, 'basis_product'],
  [/обозн|артикул|код/i, 'designation'],
  [/наим|детал/i, 'name'],
  [/кол|шт/i, 'quantity'],
  [/размер/i, 'compound_size'],
  [/длин|высот/i, 'length'],
  [/шир/i, 'width'],
  [/материал/i, 'material'],
  [/фрез/i, 'milling'],
  [/плен/i, 'film'],
  [/примеч|коммент/i, 'note'],
];

const MAX_PAGES = 100;
const MAX_TABLES = 50;
const MAX_ROWS = 5_000;
const MAX_LINES_PER_TABLE = 5_000;

export function detectGenericPdfTables(pages: PdfTextItem[][]): PdfGenericTable[] {
  if (pages.length > MAX_PAGES) {
    throw new Error(`PDF_COMPLEXITY_LIMIT: максимум ${MAX_PAGES} страниц`);
  }
  const tables: PdfGenericTable[] = [];
  let totalRows = 0;
  pages.forEach((items, pageIndex) => {
    const lines = groupTextItemsIntoLines(items);
    const tableCountBeforePage = tables.length;
    const semanticHeaderIndexes = lines.flatMap((line, index) => {
      const headerItems = mergeNearbyHeaderItems(line.items);
      return headerItems.length >= 4 && semanticHeaderCount(headerItems) >= 2 ? [index] : [];
    });

    if (semanticHeaderIndexes.length === 0 && tables.length > 0) {
      const previous = tables[tables.length - 1];
      const continuationLines = lines.filter(line => !isHeaderOrFooter(line));
      if (hasContinuationGeometry(continuationLines, previous.columns)) {
        const continuation = assembleRows(continuationLines, previous.columns);
        if (continuation.rows.length > 0) {
          totalRows += continuation.rows.length;
          assertDetectionLimits(tables.length + 1, totalRows);
          tables.push({
            ...previous,
            id: `p${pageIndex + 1}-t${tables.length + 1}`,
            pageNumber: pageIndex + 1,
            rows: continuation.rows,
            geometryCandidateCells: undefined,
            unresolvedLines: continuation.unresolvedLines,
          });
          return;
        }
      }
    }

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const header = lines[lineIndex];
      const headerItems = mergeNearbyHeaderItems(header.items);
      const semanticCount = semanticHeaderCount(headerItems);
      if (headerItems.length > 50
        && (semanticCount >= 2
          || hasStableGeometry(lines.slice(lineIndex + 1, lineIndex + 9), headerItems))) {
        throw new Error('PDF_COMPLEXITY_LIMIT: максимум 50 колонок в таблице');
      }
      if (headerItems.length < 4
        || (semanticCount < 2 && !hasStableGeometry(lines.slice(lineIndex + 1, lineIndex + 9), headerItems))) {
        continue;
      }

      const sorted = [...headerItems].sort((a, b) => a.x - b.x);
      const minX = sorted[0].x;
      const lastGap = sorted.length > 1
        ? sorted[sorted.length - 1].x - sorted[sorted.length - 2].x
        : 1;
      const maxX = semanticCount >= 2
        ? Math.max(...sorted.map(item => item.x + item.width))
        : sorted[sorted.length - 1].x + Math.max(1, lastGap);
      const columns = sorted.map((item, index): PdfGenericColumn => ({
        // Geometry-only candidates must never persist a possible document value.
        header: semanticCount >= 2 ? item.text.trim() : `column-${index + 1}`,
        minX: index === 0 ? Math.max(0, item.x - 8) : midpoint(sorted[index - 1].x, item.x),
        maxX: index === sorted.length - 1 ? Number.POSITIVE_INFINITY : midpoint(item.x, sorted[index + 1].x),
        inferredTarget: semanticCount >= 2 ? inferTarget(item.text) : 'ignore',
      }));
      const nextSemanticHeader = semanticHeaderIndexes.find(index => index > lineIndex);
      const endIndex = findTableBoundary(
        lines,
        lineIndex,
        nextSemanticHeader ?? lines.length,
        headerItems,
      );
      const candidateLines = lines.slice(lineIndex + 1, endIndex)
        .filter(line => line.y < header.y - 3);
      if (candidateLines.length > MAX_LINES_PER_TABLE) {
        throw new Error('PDF_COMPLEXITY_LIMIT: слишком много строк в таблице');
      }
      const assembled = assembleRows(candidateLines, columns);
      if (!assembled.rows.length) continue;

      totalRows += assembled.rows.length;
      assertDetectionLimits(tables.length + 1, totalRows);
      tables.push({
        id: `p${pageIndex + 1}-t${tables.length + 1}`,
        pageNumber: pageIndex + 1,
        columns,
        rows: assembled.rows,
        geometryCandidateCells: semanticCount < 2 ? cellsForLine(header, columns) : undefined,
        unresolvedLines: assembled.unresolvedLines,
        signature: {
          fingerprintVersion: 1,
          parserMajor: 1,
          headerBandCount: 1,
          columns: columns.map(column => ({
            header: column.header,
            relativeStart: finiteRatio(column.minX, minX, maxX),
            relativeEnd: Number.isFinite(column.maxX) ? finiteRatio(column.maxX, minX, maxX) : 1,
          })),
        },
      });
      lineIndex = Math.max(lineIndex, endIndex - 1);
    }
    if (tables.length === tableCountBeforePage && tables.length > 0) {
      const previous = tables[tables.length - 1];
      const continuationLines = lines.filter(line => !isHeaderOrFooter(line));
      if (hasContinuationGeometry(continuationLines, previous.columns)) {
        const continuation = assembleRows(continuationLines, previous.columns);
        if (continuation.rows.length === 0) return;
        totalRows += continuation.rows.length;
        assertDetectionLimits(tables.length + 1, totalRows);
        tables.push({
          ...previous,
          id: `p${pageIndex + 1}-t${tables.length + 1}`,
          pageNumber: pageIndex + 1,
          rows: continuation.rows,
          geometryCandidateCells: undefined,
          unresolvedLines: continuation.unresolvedLines,
        });
      }
    }
  });
  return tables;
}

export function inferredMapping(table: PdfGenericTable): PdfLayoutMapping {
  return {
    schemaVersion: 1,
    columns: table.columns.map((column, columnIndex) => ({
      columnIndex,
      target: column.inferredTarget,
    })),
  };
}

export function mapGenericTableRows(
  table: PdfGenericTable,
  mapping: PdfLayoutMapping,
  unresolvedActions: Record<number, PdfUnresolvedLineAction> = {},
): { rows: ImportRow[]; issues: string[] } {
  const issues: string[] = [];
  const rows: ImportRow[] = [];
  if (table.geometryCandidateCells && !mapping.geometryCandidateRole) {
    issues.push('Не указано, является ли первая строка заголовком или данными');
  }
  const classifiedRows = table.rows.map(cells => [...cells]);
  table.unresolvedLines.forEach((cells, index) => {
    const action = unresolvedActions[index];
    if (!action) {
      issues.push(`Не классифицирована строка таблицы ${index + 1}`);
    } else if (action.kind === 'row') {
      classifiedRows.push([...cells]);
    } else if (action.kind === 'attach') {
      const target = classifiedRows[action.rowIndex];
      if (!target) {
        issues.push(`Строка таблицы ${index + 1}: выбрана отсутствующая строка назначения`);
        return;
      }
      cells.forEach((cell, columnIndex) => {
        if (!cell) return;
        target[columnIndex] = [target[columnIndex], cell].filter(Boolean).join(' ');
      });
    }
  });
  const sourceRows = mapping.geometryCandidateRole === 'data' && table.geometryCandidateCells
    ? [table.geometryCandidateCells, ...classifiedRows]
    : classifiedRows;
  sourceRows.forEach((cells, rowIndex) => {
    const values = new Map<PdfLayoutTarget, string>();
    mapping.columns.forEach(rule => {
      if (rule.target !== 'ignore') values.set(rule.target, cells[rule.columnIndex]?.trim() ?? '');
    });
    const size = numbers(values.get('compound_size'));
    const height = positiveNumber(values.get('length')) ?? size[0] ?? null;
    const width = positiveNumber(values.get('width')) ?? size[1] ?? null;
    const quantity = positiveInteger(values.get('quantity'));
    const name = values.get('name')?.trim();
    if (!height || !width || !quantity || !name) {
      issues.push(`Строка ${rowIndex + 1}: не распознаны обязательные поля`);
      return;
    }
    rows.push({
      sourceRowIndex: rowIndex,
      height,
      width,
      quantity,
      detailName: name,
      basisDesignation: values.get('designation') || null,
      basisData: null,
      basisProject: values.get('basis_project') || null,
      basisProduct: values.get('basis_product') || null,
      materialName: values.get('material') || null,
      millingTypeName: values.get('milling') || null,
      filmName: values.get('film') || null,
      note: values.get('note') || null,
    });
  });
  return { rows, issues };
}

function assembleRows(
  lines: ReturnType<typeof groupTextItemsIntoLines>,
  columns: PdfGenericColumn[],
): { rows: string[][]; unresolvedLines: string[][] } {
  const rows: string[][] = [];
  const unresolvedLines: string[][] = [];
  let current: string[] | null = null;
  let currentY: number | null = null;
  const positionIndex = columns.findIndex(column => column.inferredTarget === 'position');
  const nameIndex = columns.findIndex(column => column.inferredTarget === 'name');
  const quantityIndex = columns.findIndex(column => column.inferredTarget === 'quantity');
  for (const line of lines) {
    if (/общ\.\s*кол|итого|стр\./i.test(line.text)) break;
    const cells = cellsForLine(line, columns);
    const occupied = cells.filter(Boolean).length;
    const startsRow = positionIndex >= 0
      ? /^\d{1,4}$/.test(cells[positionIndex] ?? '')
      : nameIndex >= 0
        ? Boolean(cells[nameIndex])
          && (quantityIndex < 0 || /^\d+(?:[.,]\d+)?$/.test(cells[quantityIndex] ?? ''))
        : Boolean(cells[0]) && occupied >= 3;
    if (startsRow) {
      current = cells;
      currentY = line.y;
      rows.push(current);
    } else if (current && currentY !== null && currentY - line.y <= 18) {
      cells.forEach((cell, index) => {
        if (!cell) return;
        const punctuationContinuation = index === 1 && /^[.\d]+$/.test(cell);
        current![index] = punctuationContinuation
          ? `${current![index]}${cell}`.replace(/\s+/g, '')
          : [current![index], cell].filter(Boolean).join(' ');
      });
      currentY = line.y;
    } else if (occupied > 0) {
      unresolvedLines.push(cells);
      current = null;
      currentY = null;
    }
  }
  if (rows.length > MAX_ROWS) {
    throw new Error('PDF_COMPLEXITY_LIMIT: слишком много строк таблицы');
  }
  return { rows, unresolvedLines };
}

function cellsForLine(
  line: ReturnType<typeof groupTextItemsIntoLines>[number],
  columns: PdfGenericColumn[],
) {
  return columns.map(column => line.items
    .filter(item => item.x >= column.minX && item.x < column.maxX)
    .sort((a, b) => a.x - b.x)
    .map(item => item.text.trim())
    .filter(Boolean)
    .join(' '));
}

function mergeNearbyHeaderItems(items: PdfTextItem[]): PdfTextItem[] {
  return [...items]
    .filter(item => item.text.trim())
    .sort((a, b) => a.x - b.x);
}
function semanticHeaderCount(items: PdfTextItem[]) {
  return items.filter(item => inferTarget(item.text) !== 'ignore').length;
}
function hasStableGeometry(
  lines: ReturnType<typeof groupTextItemsIntoLines>,
  headerItems: PdfTextItem[],
) {
  const xs = headerItems.map(item => item.x);
  return lines.filter(line => {
    const occupied = new Set(line.items.map(item => {
      let nearest = 0;
      for (let index = 1; index < xs.length; index += 1) {
        if (Math.abs(item.x - xs[index]) < Math.abs(item.x - xs[nearest])) nearest = index;
      }
      return Math.abs(item.x - xs[nearest]) <= 24 ? nearest : -1;
    }).filter(index => index >= 0));
    return occupied.size >= 3;
  }).length >= 3;
}
function hasContinuationGeometry(
  lines: ReturnType<typeof groupTextItemsIntoLines>,
  columns: PdfGenericColumn[],
) {
  const plausibleLines = lines.filter(line => !isTableTerminator(line.text)).filter(line => {
    const occupied = columns.filter(column =>
      line.items.some(item => item.x >= column.minX && item.x < column.maxX)).length;
    return occupied >= Math.min(3, columns.length);
  });
  if (plausibleLines.length === 0) return false;
  const rows = assembleRows(lines, columns).rows;
  return rows.length > 0 && plausibleLines.length >= rows.length;
}
function findTableBoundary(
  lines: ReturnType<typeof groupTextItemsIntoLines>,
  headerIndex: number,
  semanticBoundary: number,
  headerItems: PdfTextItem[],
) {
  const hardEnd = Math.min(semanticBoundary, lines.length);
  for (let index = headerIndex + 1; index < hardEnd; index += 1) {
    if (isTableTerminator(lines[index].text)) return index;
    if (index < headerIndex + 2) continue;
    const items = mergeNearbyHeaderItems(lines[index].items);
    if (items.length < 4
      || !hasStableGeometry(lines.slice(index + 1, index + 9), items)) continue;
    const previousGaps = lines.slice(Math.max(headerIndex, index - 5), index)
      .map((line, gapIndex, source) => gapIndex === 0 ? 0 : source[gapIndex - 1].y - line.y)
      .filter(gap => gap > 0)
      .sort((a, b) => a - b);
    const medianGap = previousGaps[Math.floor(previousGaps.length / 2)] ?? 0;
    const verticalGap = lines[index - 1].y - lines[index].y;
    if (verticalGap > Math.max(36, medianGap * 2.2)
      || (
        topologyDistance(headerItems, items) > 0.25
        && verticalGap > Math.max(28, medianGap * 1.8)
      )) {
      return index;
    }
  }
  return hardEnd;
}
function topologyDistance(left: PdfTextItem[], right: PdfTextItem[]) {
  const leftXs = [...left].sort((a, b) => a.x - b.x).map(item => item.x);
  const rightXs = [...right].sort((a, b) => a.x - b.x).map(item => item.x);
  if (leftXs.length !== rightXs.length) return 1;
  const span = Math.max(1, leftXs[leftXs.length - 1] - leftXs[0]);
  return leftXs.reduce((sum, x, index) =>
    sum + Math.abs((x - leftXs[0]) - (rightXs[index] - rightXs[0])) / span, 0) / leftXs.length;
}
function isTableTerminator(text: string) {
  return /общ\.\s*кол|итого|стр\.\s*\d|^изделие:|^заказ:/i.test(text.trim());
}
function assertDetectionLimits(tableCount: number, rowCount: number) {
  if (tableCount > MAX_TABLES) {
    throw new Error(`PDF_COMPLEXITY_LIMIT: максимум ${MAX_TABLES} таблиц`);
  }
  if (rowCount > MAX_ROWS) {
    throw new Error(`PDF_COMPLEXITY_LIMIT: максимум ${MAX_ROWS} строк`);
  }
}
function inferTarget(text: string): PdfLayoutTarget {
  return HEADER_ALIASES.find(([pattern]) => pattern.test(text.trim()))?.[1] ?? 'ignore';
}
function midpoint(a: number, b: number) { return (a + b) / 2; }
function finiteRatio(value: number, min: number, max: number) {
  const ratio = (value - min) / Math.max(1, max - min);
  return Math.round(Math.min(1, Math.max(0, ratio)) * 1000) / 1000;
}
function numbers(value: string | undefined) {
  return (value?.match(/\d+(?:[.,]\d+)?/g) ?? []).map(item => Number(item.replace(',', '.')));
}
function positiveNumber(value: string | undefined) {
  const parsed = Number(value?.replace(',', '.'));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}
function positiveInteger(value: string | undefined) {
  const parsed = Number(value?.replace(',', '.'));
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
