// Hook for parsing PDF files using pdfjs-dist

import { useState, useCallback } from 'react';
import type { TextItem } from 'pdfjs-dist/types/src/display/api';
import type { PdfTextItem, PdfParsedResult } from '../types/pdfTypes';
import { parsePdfContent, convertToImportRows } from '../utils/pdfTextExtractor';
import type { ImportRow } from '../types/importTypes';

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
  result: PdfParsedResult | null;
  importRows: ImportRow[];
  parseFile: (file: File) => Promise<void>;
  reset: () => void;
}

const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20MB

export const usePdfParser = (): UsePdfParserReturn => {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PdfParsedResult | null>(null);
  const [importRows, setImportRows] = useState<ImportRow[]>([]);

  const parseFile = useCallback(async (file: File): Promise<void> => {
    setIsLoading(true);
    setError(null);
    setResult(null);
    setImportRows([]);

    try {
      // Validate file type
      if (!file.name.toLowerCase().endsWith('.pdf')) {
        throw new Error('Неподдерживаемый формат файла. Требуется PDF.');
      }

      // Validate file size
      if (file.size > MAX_FILE_SIZE) {
        throw new Error(`Файл слишком большой. Максимальный размер: ${MAX_FILE_SIZE / 1024 / 1024} МБ`);
      }

      // Read file as ArrayBuffer
      const arrayBuffer = await file.arrayBuffer();

      const pdfjsLib = await loadPdfjs();

      // Load PDF document
      const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
      const pdf = await loadingTask.promise;

      // Extract text from all pages
      const allPageItems: PdfTextItem[][] = [];

      for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const textContent = await page.getTextContent();

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
      }

      // Parse the extracted text
      const parsedResult = parsePdfContent(allPageItems);
      setResult(parsedResult);

      // Convert to import rows
      const rows = convertToImportRows(parsedResult);
      setImportRows(rows);

      // Log parsing results for debugging
      console.log('[usePdfParser] Parsed result:', parsedResult);
      console.log('[usePdfParser] Import rows:', rows.length);

    } catch (err) {
      console.error('[usePdfParser] Error parsing PDF:', err);
      setError(err instanceof Error ? err.message : 'Ошибка при чтении PDF файла');
      setResult(null);
      setImportRows([]);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const reset = useCallback((): void => {
    setIsLoading(false);
    setError(null);
    setResult(null);
    setImportRows([]);
  }, []);

  return {
    isLoading,
    error,
    result,
    importRows,
    parseFile,
    reset,
  };
};
