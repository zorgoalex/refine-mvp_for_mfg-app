// Hook for parsing Excel files using SheetJS (xlsx)

import { useState, useCallback } from 'react';
import * as XLSX from 'xlsx';
import type { WorkBook } from 'xlsx';
import type { ParsedSheet, CellValue } from '../types/importTypes';
import { getColumnLetter } from '../types/importTypes';

export interface UseExcelParserReturn {
  // State
  workbook: WorkBook | null;
  sheets: string[];
  selectedSheet: string | null;
  sheetData: ParsedSheet | null;
  isLoading: boolean;
  error: string | null;

  // Actions
  parseFile: (file: File) => Promise<void>;
  selectSheet: (sheetName: string) => void;
  reset: () => void;
}

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB
const SUPPORTED_EXTENSIONS = ['.xlsx', '.xls', '.xlsm', '.xlsb'];

/**
 * Parse a worksheet into a 2D array of cell values
 */
const parseWorksheet = (ws: XLSX.WorkSheet): ParsedSheet => {
  // Get sheet range
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
  const rowCount = range.e.r - range.s.r + 1;
  const colCount = range.e.c - range.s.c + 1;

  // Generate column headers (A, B, C, ...)
  const headers: string[] = [];
  for (let c = 0; c < colCount; c++) {
    headers.push(getColumnLetter(c));
  }

  // Parse data into 2D array
  const data: CellValue[][] = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const row: CellValue[] = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cellAddress = XLSX.utils.encode_cell({ r, c });
      const cell = ws[cellAddress];

      if (!cell) {
        row.push(null);
      } else if (cell.t === 'n') {
        // Number
        row.push(cell.v as number);
      } else if (cell.t === 's') {
        // String
        row.push(cell.v as string);
      } else if (cell.t === 'b') {
        // Boolean
        row.push(cell.v as boolean);
      } else if (cell.t === 'd') {
        // Date
        row.push(cell.v as Date);
      } else {
        // Fallback to formatted value or raw value
        row.push(cell.w || cell.v || null);
      }
    }
    data.push(row);
  }

  return {
    name: '',
    data,
    headers,
    rowCount,
    colCount,
  };
};

/**
 * Hook for parsing Excel files
 */
export const useExcelParser = (): UseExcelParserReturn => {
  const [workbook, setWorkbook] = useState<WorkBook | null>(null);
  const [sheets, setSheets] = useState<string[]>([]);
  const [selectedSheet, setSelectedSheet] = useState<string | null>(null);
  const [sheetData, setSheetData] = useState<ParsedSheet | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Parse an Excel file
   */
  const parseFile = useCallback(async (file: File): Promise<void> => {
    setIsLoading(true);
    setError(null);

    try {
      // Validate file extension
      const fileName = file.name.toLowerCase();
      const hasValidExtension = SUPPORTED_EXTENSIONS.some(ext => fileName.endsWith(ext));
      if (!hasValidExtension) {
        throw new Error(`Неподдерживаемый формат файла. Поддерживаются: ${SUPPORTED_EXTENSIONS.join(', ')}`);
      }

      // Validate file size
      if (file.size > MAX_FILE_SIZE) {
        throw new Error(`Файл слишком большой. Максимальный размер: ${MAX_FILE_SIZE / 1024 / 1024} МБ`);
      }

      // Read file as ArrayBuffer
      const arrayBuffer = await file.arrayBuffer();

      // Parse workbook
      const wb = XLSX.read(arrayBuffer, {
        type: 'array',
        cellDates: true,
        cellNF: false,
        cellText: true,
      });

      setWorkbook(wb);
      setSheets(wb.SheetNames);

      // Auto-select first sheet
      if (wb.SheetNames.length > 0) {
        const firstSheet = wb.SheetNames[0];
        setSelectedSheet(firstSheet);

        // Parse first sheet
        const ws = wb.Sheets[firstSheet];
        const parsed = parseWorksheet(ws);
        parsed.name = firstSheet;
        setSheetData(parsed);
      }
    } catch (err) {
      console.error('[useExcelParser] Error parsing file:', err);
      setError(err instanceof Error ? err.message : 'Ошибка при чтении файла');
      setWorkbook(null);
      setSheets([]);
      setSelectedSheet(null);
      setSheetData(null);
    } finally {
      setIsLoading(false);
    }
  }, []);

  /**
   * Select a different sheet
   */
  const selectSheet = useCallback((sheetName: string): void => {
    if (!workbook || !workbook.SheetNames.includes(sheetName)) {
      return;
    }

    setSelectedSheet(sheetName);

    const ws = workbook.Sheets[sheetName];
    const parsed = parseWorksheet(ws);
    parsed.name = sheetName;
    setSheetData(parsed);
  }, [workbook]);

  /**
   * Reset all state
   */
  const reset = useCallback((): void => {
    setWorkbook(null);
    setSheets([]);
    setSelectedSheet(null);
    setSheetData(null);
    setIsLoading(false);
    setError(null);
  }, []);

  return {
    workbook,
    sheets,
    selectedSheet,
    sheetData,
    isLoading,
    error,
    parseFile,
    selectSheet,
    reset,
  };
};
