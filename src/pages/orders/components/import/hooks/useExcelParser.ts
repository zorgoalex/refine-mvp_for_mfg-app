// Hook for parsing Excel files using SheetJS (xlsx)

import { useState, useCallback } from 'react';
import * as XLSX from 'xlsx';
import type { WorkBook } from 'xlsx';
import type { ParsedSheet, CellValue } from '../types/importTypes';
import { getColumnLetter } from '../types/importTypes';

export interface UseExcelParserReturn {
  workbook: WorkBook | null;
  sheets: string[];
  selectedSheet: string | null;
  sheetData: ParsedSheet | null;
  isLoading: boolean;
  error: string | null;
  parseFile: (file: File) => Promise<void>;
  selectSheet: (sheetName: string) => void;
  reset: () => void;
}

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const SUPPORTED_EXTENSIONS = ['.xlsx', '.xls', '.xlsm', '.xlsb'];

const parseWorksheet = (ws: XLSX.WorkSheet): ParsedSheet => {
  const range = XLSX.utils.decode_range(ws['!ref'] || 'A1');
  const rowCount = range.e.r - range.s.r + 1;
  const colCount = range.e.c - range.s.c + 1;

  const headers: string[] = [];
  for (let c = 0; c < colCount; c++) {
    headers.push(getColumnLetter(c));
  }

  const data: CellValue[][] = [];
  for (let r = range.s.r; r <= range.e.r; r++) {
    const row: CellValue[] = [];
    for (let c = range.s.c; c <= range.e.c; c++) {
      const cellAddress = XLSX.utils.encode_cell({ r, c });
      const cell = ws[cellAddress];

      if (!cell) {
        row.push(null);
      } else if (cell.t === 'n') {
        row.push(cell.v as number);
      } else if (cell.t === 's') {
        row.push(cell.v as string);
      } else if (cell.t === 'b') {
        row.push(cell.v as boolean);
      } else if (cell.t === 'd') {
        row.push(cell.v as Date);
      } else {
        row.push(cell.w || cell.v || null);
      }
    }
    data.push(row);
  }

  return { name: '', data, headers, rowCount, colCount };
};

export const useExcelParser = (): UseExcelParserReturn => {
  const [workbook, setWorkbook] = useState<WorkBook | null>(null);
  const [sheets, setSheets] = useState<string[]>([]);
  const [selectedSheet, setSelectedSheet] = useState<string | null>(null);
  const [sheetData, setSheetData] = useState<ParsedSheet | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const parseFile = useCallback(async (file: File): Promise<void> => {
    setIsLoading(true);
    setError(null);

    try {
      const fileName = file.name.toLowerCase();
      const hasValidExtension = SUPPORTED_EXTENSIONS.some(ext => fileName.endsWith(ext));
      if (!hasValidExtension) {
        throw new Error(`Неподдерживаемый формат файла. Поддерживаются: ${SUPPORTED_EXTENSIONS.join(', ')}`);
      }

      if (file.size > MAX_FILE_SIZE) {
        throw new Error(`Файл слишком большой. Максимальный размер: ${MAX_FILE_SIZE / 1024 / 1024} МБ`);
      }

      const arrayBuffer = await file.arrayBuffer();
      const wb = XLSX.read(arrayBuffer, { type: 'array', cellDates: true, cellNF: false, cellText: true });

      setWorkbook(wb);
      setSheets(wb.SheetNames);

      if (wb.SheetNames.length > 0) {
        const firstSheet = wb.SheetNames[0];
        setSelectedSheet(firstSheet);
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

  const selectSheet = useCallback((sheetName: string): void => {
    if (!workbook || !workbook.SheetNames.includes(sheetName)) return;

    setSelectedSheet(sheetName);
    const ws = workbook.Sheets[sheetName];
    const parsed = parseWorksheet(ws);
    parsed.name = sheetName;
    setSheetData(parsed);
  }, [workbook]);

  const reset = useCallback((): void => {
    setWorkbook(null);
    setSheets([]);
    setSelectedSheet(null);
    setSheetData(null);
    setIsLoading(false);
    setError(null);
  }, []);

  return { workbook, sheets, selectedSheet, sheetData, isLoading, error, parseFile, selectSheet, reset };
};
