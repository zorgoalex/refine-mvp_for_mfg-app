// Hook for parsing PDF files using pdfjs-dist

import { useState, useCallback } from 'react';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import type { PdfTextItem, PdfParsedResult } from '../types/pdfTypes';
import { parsePdfContent, convertToImportRows } from '../utils/pdfTextExtractor';
import type { ImportRow } from '../types/importTypes';
import { featureFlags } from '../../../../../config/featureFlags';
import {
  detectGenericPdfTables,
  inferredMapping,
  mapGenericTableRows,
  type PdfGenericTable,
  type PdfUnresolvedLineAction,
} from '../utils/pdfGenericTable';
import {
  validatePdfLayoutMapping,
  serializePdfLayoutSignature,
  type PdfLayoutMapping,
  type PdfLayoutTarget,
} from '../utils/pdfLayoutPattern';
import { pdfTablePatternsApi, type PdfPatternMatch } from '../api/pdfTablePatternsApi';
import { can } from '../../../../../utils/permissions';

type PdfjsModule = typeof import('pdfjs-dist');

const PDF_WORKER_SRC = new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).toString();
let pdfjsPromise: Promise<PdfjsModule> | null = null;
let isWorkerConfigured = false;

async function loadPdfjs(): Promise<PdfjsModule> {
  if (!pdfjsPromise) {
    pdfjsPromise = import('pdfjs-dist');
  }

  const pdfjsLib = await pdfjsPromise;
  if (!isWorkerConfigured) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC;
    isWorkerConfigured = true;
  }

  return pdfjsLib;
}

export interface UsePdfParserReturn {
  isLoading: boolean;
  error: string | null;
  fileName: string | null;
  result: PdfParsedResult | null;
  importRows: ImportRow[];
  genericTables: PdfGenericTable[];
  layoutMappings: Record<string, PdfLayoutMapping>;
  patternMatches: PdfPatternMatch[];
  needsLayoutMapping: boolean;
  layoutIssues: string[];
  patternSaveWarning: string | null;
  setColumnTarget: (tableId: string, columnIndex: number, target: PdfLayoutTarget) => void;
  setGeometryCandidateRole: (tableId: string, role: 'header' | 'data') => void;
  setUnresolvedLineAction: (
    tableId: string,
    lineIndex: number,
    action: PdfUnresolvedLineAction,
  ) => void;
  confirmLayouts: () => Promise<ImportRow[] | null>;
  parseFile: (file: File) => Promise<void>;
  createCheckpoint: () => PdfParserCheckpoint;
  restoreCheckpoint: (checkpoint: PdfParserCheckpoint) => void;
  reset: () => void;
}

export interface PdfParserCheckpoint {
  fileName: string | null;
  result: PdfParsedResult | null;
  importRows: ImportRow[];
  genericTables: PdfGenericTable[];
  layoutMappings: Record<string, PdfLayoutMapping>;
  patternMatches: PdfPatternMatch[];
  needsLayoutMapping: boolean;
  layoutIssues: string[];
  patternSaveWarning: string | null;
  unresolvedLineActions: Record<string, Record<number, PdfUnresolvedLineAction>>;
}

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

export const usePdfParser = (): UsePdfParserReturn => {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [result, setResult] = useState<PdfParsedResult | null>(null);
  const [importRows, setImportRows] = useState<ImportRow[]>([]);
  const [genericTables, setGenericTables] = useState<PdfGenericTable[]>([]);
  const [layoutMappings, setLayoutMappings] = useState<Record<string, PdfLayoutMapping>>({});
  const [patternMatches, setPatternMatches] = useState<PdfPatternMatch[]>([]);
  const [needsLayoutMapping, setNeedsLayoutMapping] = useState(false);
  const [layoutIssues, setLayoutIssues] = useState<string[]>([]);
  const [patternSaveWarning, setPatternSaveWarning] = useState<string | null>(null);
  const [unresolvedLineActions, setUnresolvedLineActions] = useState<
    Record<string, Record<number, PdfUnresolvedLineAction>>
  >({});

  const parseFile = useCallback(async (file: File): Promise<void> => {
    const parseStartedAt = Date.now();
    setIsLoading(true);
    setError(null);
    setResult(null);
    setImportRows([]);
    setGenericTables([]);
    setPatternMatches([]);
    setNeedsLayoutMapping(false);
    setLayoutIssues([]);
    setPatternSaveWarning(null);
    setUnresolvedLineActions({});

    try {
      // Validate file type
      if (!file.name.toLowerCase().endsWith('.pdf')) {
        throw new Error('Неподдерживаемый формат файла. Требуется PDF.');
      }

      // Validate file size
      if (file.size > MAX_FILE_SIZE) {
        throw new Error(`Файл слишком большой. Максимальный размер: ${MAX_FILE_SIZE / 1024 / 1024} МБ`);
      }

      setFileName(file.name);

      // Read file as ArrayBuffer
      const arrayBuffer = await file.arrayBuffer();

      const pdfjsLib = await loadPdfjs();

      // Load PDF document
      const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
      const pdf = await loadingTask.promise;
      if (pdf.numPages > 100) {
        throw new Error('PDF_COMPLEXITY_LIMIT: максимум 100 страниц');
      }

      // Extract text from all pages
      const allPageItems: PdfTextItem[][] = [];

      for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
        if (Date.now() - parseStartedAt > 15_000) {
          throw new Error('PDF_COMPLEXITY_LIMIT: превышено время разбора');
        }
        const page = await pdf.getPage(pageNum);
        const textContent = await page.getTextContent();
        if (textContent.items.length > 20_000) {
          throw new Error(`PDF_COMPLEXITY_LIMIT: слишком много элементов на странице ${pageNum}`);
        }

        const pageItems: PdfTextItem[] = [];

        for (const item of textContent.items) {
          // Type guard for TextItem
          if ('str' in item && 'transform' in item) {
            const textItem = item as TextItem;
            if (textItem.str.trim()) {
              pageItems.push({
                text: textItem.str,
                x: textItem.transform[4],
                y: textItem.transform[5],
                width: textItem.width,
                height: textItem.height,
                fontName: textItem.fontName,
              });
            }
          }
        }

        allPageItems.push(pageItems);
        if (allPageItems.reduce((sum, pageItems) => sum + pageItems.length, 0) > 250_000) {
          throw new Error('PDF_COMPLEXITY_LIMIT: слишком много текстовых элементов');
        }
      }

      // Parse the extracted text
      const parsedResult = parsePdfContent(allPageItems);
      setResult(parsedResult);

      const detectedTables = detectGenericPdfTables(allPageItems);
      if (featureFlags.pdfImportLayoutPatterns && detectedTables.length === 0) {
        throw new Error(
          'PDF_LAYOUT_UNRESOLVED: таблицы не найдены; импорт остановлен без частичного fallback',
        );
      }
      const detectedRows = detectedTables.reduce((sum, table) => sum + table.rows.length, 0);
      const detectedCells = detectedTables.reduce(
        (sum, table) => sum + table.rows.length * table.columns.length,
        0,
      );
      if (detectedRows > 5_000 || detectedCells > 100_000) {
        throw new Error('PDF_COMPLEXITY_LIMIT: слишком большая таблица');
      }
      setGenericTables(detectedTables);
      const defaults = Object.fromEntries(
        detectedTables.map(table => [table.id, inferredMapping(table)]),
      );
      setLayoutMappings(defaults);

      if (featureFlags.pdfImportLayoutPatterns && detectedTables.length > 0) {
        let matches: PdfPatternMatch[] = [];
        try {
          matches = await pdfTablePatternsApi.match(detectedTables.map(table => table.signature));
        } catch {
          // Import remains available. Unknown/offline pattern requires confirmation.
        }
        setPatternMatches(matches);
        const resolvedMappings = { ...defaults };
        detectedTables.forEach((table, index) => {
          const match = matches.find(item => item.index === index);
          if (match?.pattern?.mapping) resolvedMappings[table.id] = match.pattern.mapping;
        });
        setLayoutMappings(resolvedMappings);
        const exactApproved = detectedTables.every((_, index) => {
          const match = matches.find(item => item.index === index);
          return match?.status === 'exact' && !match.requiresConfirmation;
        });
        const mappedResults = detectedTables.map(table =>
          mapGenericTableRows(table, resolvedMappings[table.id]));
        const mapped = mappedResults.flatMap(item => item.rows);
        const mappedQuantity = mapped.reduce((sum, row) => sum + row.quantity, 0);
        const mappingIsClean = mappedResults.every(item => item.issues.length === 0)
          && detectedTables.every(table =>
            validatePdfLayoutMapping(
              resolvedMappings[table.id],
              table.columns.length,
            ).length === 0)
          && mapped.length > 0
          && Boolean(parsedResult.metadata.totalCount)
          && parsedResult.metadata.totalCount === mappedQuantity;
        if (exactApproved && mappingIsClean) {
          setImportRows(withDocumentMetadata(mapped, parsedResult));
          setNeedsLayoutMapping(false);
        } else {
          if (exactApproved && !mappingIsClean) {
            setLayoutIssues(['Известный паттерн не прошёл проверку строк/итогового количества']);
          }
          setImportRows([]);
          setNeedsLayoutMapping(true);
        }
      } else {
        setImportRows(convertToImportRows(parsedResult));
      }

      // Log parsing results for debugging
      console.log('[usePdfParser] Parsed result:', parsedResult);

    } catch (err) {
      console.error('[usePdfParser] Error parsing PDF:', err);
      setError(err instanceof Error ? err.message : 'Ошибка при чтении PDF файла');
      setFileName(null);
      setResult(null);
      setImportRows([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const setColumnTarget = useCallback((
    tableId: string,
    columnIndex: number,
    target: PdfLayoutTarget,
  ) => {
    setLayoutMappings(current => {
      const sourceTable = genericTables.find(table => table.id === tableId);
      const mapping = current[tableId];
      if (!mapping) return current;
      const next = { ...current };
      const sourceSignature = sourceTable
        ? serializePdfLayoutSignature(sourceTable.signature)
        : null;
      genericTables.forEach(table => {
        if (table.id !== tableId
          && sourceSignature !== serializePdfLayoutSignature(table.signature)) return;
        next[table.id] = {
          ...mapping,
          columns: mapping.columns.map(column =>
            column.columnIndex === columnIndex ? { ...column, target } : column),
        };
      });
      return next;
    });
  }, [genericTables]);

  const setGeometryCandidateRole = useCallback((
    tableId: string,
    role: 'header' | 'data',
  ) => {
    setLayoutMappings(current => {
      const sourceTable = genericTables.find(table => table.id === tableId);
      if (!sourceTable) return current;
      const sourceSignature = serializePdfLayoutSignature(sourceTable.signature);
      const next = { ...current };
      genericTables.forEach(table => {
        if (serializePdfLayoutSignature(table.signature) !== sourceSignature) return;
        next[table.id] = { ...next[table.id], geometryCandidateRole: role };
      });
      return next;
    });
  }, [genericTables]);

  const setUnresolvedLineAction = useCallback((
    tableId: string,
    lineIndex: number,
    action: PdfUnresolvedLineAction,
  ) => {
    setUnresolvedLineActions(current => ({
      ...current,
      [tableId]: { ...(current[tableId] ?? {}), [lineIndex]: action },
    }));
  }, []);

  const confirmLayouts = useCallback(async (): Promise<ImportRow[] | null> => {
    const issues: string[] = [];
    const mappedRows: ImportRow[] = [];
    genericTables.forEach(table => {
      const mapping = layoutMappings[table.id];
      if (!mapping) {
        issues.push(`${table.id}: сопоставление отсутствует`);
        return;
      }
      issues.push(...validatePdfLayoutMapping(mapping, table.columns.length)
        .map(issue => `${table.id}: ${issue}`));
      const mapped = mapGenericTableRows(
        table,
        mapping,
        unresolvedLineActions[table.id],
      );
      issues.push(...mapped.issues.map(issue => `${table.id}: ${issue}`));
      mappedRows.push(...mapped.rows);
    });
    const mappedQuantity = mappedRows.reduce((sum, row) => sum + row.quantity, 0);
    if (result?.metadata.totalCount && result.metadata.totalCount !== mappedQuantity) {
      issues.push(
        `Итог PDF: ${result.metadata.totalCount}, после сопоставления: ${mappedQuantity}`,
      );
    }
    if (issues.length || !mappedRows.length) {
      setLayoutIssues(issues.length ? issues : ['Нет строк для импорта']);
      return null;
    }
    setLayoutIssues([]);
    const completedRows = result ? withDocumentMetadata(mappedRows, result) : mappedRows;
    setImportRows(completedRows);
    setNeedsLayoutMapping(false);
    if (featureFlags.pdfImportLayoutPatterns) {
      const uniqueTables = genericTables.filter((table, index, all) =>
        all.findIndex(candidate =>
          serializePdfLayoutSignature(candidate.signature)
          === serializePdfLayoutSignature(table.signature)) === index);
      const saves = await Promise.allSettled(uniqueTables.map(table => {
        const index = genericTables.indexOf(table);
        const match = patternMatches.find(item => item.index === index);
        if (match?.status !== 'exact') {
          return pdfTablePatternsApi.learn(table.signature, layoutMappings[table.id]);
        }
        if (match.pattern && match.requiresConfirmation && can('bazis.manage')) {
          return pdfTablePatternsApi.approve(match.pattern, layoutMappings[table.id]);
        }
        return Promise.resolve();
      }));
      if (saves.some(save => save.status === 'rejected')) {
        setPatternSaveWarning(
          'Детали распознаны, но layout-паттерн не сохранён. При следующем импорте потребуется подтверждение.',
        );
      } else {
        setPatternSaveWarning(null);
      }
    }
    return completedRows;
  }, [genericTables, layoutMappings, patternMatches, result, unresolvedLineActions]);

  const createCheckpoint = useCallback((): PdfParserCheckpoint => ({
    fileName,
    result,
    importRows,
    genericTables: genericTables.map((table) => ({
      ...table,
      columns: table.columns.map((column) => ({
        ...column,
        maxX: Number.isFinite(column.maxX) ? column.maxX : Number.MAX_SAFE_INTEGER,
      })),
    })),
    layoutMappings,
    patternMatches,
    needsLayoutMapping,
    layoutIssues,
    patternSaveWarning,
    unresolvedLineActions,
  }), [
    fileName,
    genericTables,
    importRows,
    layoutIssues,
    layoutMappings,
    needsLayoutMapping,
    patternMatches,
    patternSaveWarning,
    result,
    unresolvedLineActions,
  ]);

  const restoreCheckpoint = useCallback((checkpoint: PdfParserCheckpoint): void => {
    setIsLoading(false);
    setError(null);
    setFileName(checkpoint.fileName);
    setResult(checkpoint.result);
    setImportRows(checkpoint.importRows);
    setGenericTables(checkpoint.genericTables);
    setLayoutMappings(checkpoint.layoutMappings);
    setPatternMatches(checkpoint.patternMatches);
    setNeedsLayoutMapping(checkpoint.needsLayoutMapping);
    setLayoutIssues(checkpoint.layoutIssues);
    setPatternSaveWarning(checkpoint.patternSaveWarning);
    setUnresolvedLineActions(checkpoint.unresolvedLineActions);
  }, []);

  const reset = useCallback((): void => {
    setIsLoading(false);
    setError(null);
    setFileName(null);
    setResult(null);
    setImportRows([]);
    setGenericTables([]);
    setLayoutMappings({});
    setPatternMatches([]);
    setNeedsLayoutMapping(false);
    setLayoutIssues([]);
    setPatternSaveWarning(null);
    setUnresolvedLineActions({});
  }, []);

  return {
    isLoading,
    error,
    fileName,
    result,
    importRows,
    genericTables,
    layoutMappings,
    patternMatches,
    needsLayoutMapping,
    layoutIssues,
    patternSaveWarning,
    setColumnTarget,
    setGeometryCandidateRole,
    setUnresolvedLineAction,
    confirmLayouts,
    parseFile,
    createCheckpoint,
    restoreCheckpoint,
    reset,
  };
};

function withDocumentMetadata(rows: ImportRow[], result: PdfParsedResult): ImportRow[] {
  const basisProject = result.metadata.orderNumber || null;
  const basisProduct = result.metadata.productName || result.metadata.orderName || null;
  return rows.map(row => ({
    ...row,
    basisProject: row.basisProject || basisProject,
    basisProduct: row.basisProduct || basisProduct,
  }));
}
