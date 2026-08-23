// Hook for parsing Excel files using SheetJS (xlsx)
// xlsx is loaded dynamically on first parse so it becomes a separate async chunk
// and does NOT land in the entry bundle.

import { useState, useCallback } from 'react';
import type { WorkBook, WorkSheet, Utils } from 'xlsx';
import type { ParsedSheet, CellValue } from '../types/importTypes';
import { getColumnLetter } from '../types/importTypes';

// Module-level promise singleton — guards against concurrent parseFile calls
// racing to issue two separate dynamic imports before the first one resolves.
let xlsxPromise: Promise<typeof import('xlsx')> | null = null;
// Resolved module reference used by the synchronous selectSheet.
// Set once after the first await; never cleared (module stays cached).
let xlsxModule: typeof import('xlsx') | null = null;

export interface UseExcelParserReturn {
  workbook: WorkBook | null;
  sheets: string[];
  selectedSheet: string | null;
  sheetData: ParsedSheet | null;
  isLoading: boolean;
  error: string | null;
  parseFile: (file: File, preferredSheet?: string | null) => Promise<void>;
  selectSheet: (sheetName: string) => void;
  restoreWorkbook: (workbook: WorkBook, selectedSheet?: string | null) => boolean;
  reset: () => void;
}

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const SUPPORTED_EXTENSIONS = ['.xlsx', '.xls', '.xlsm', '.xlsb'];

/**
 * Pure worksheet parser. Exported for unit testing.
 * Receives the xlsx utils object so there is NO top-level runtime reference to
 * the xlsx package — the caller obtains it via dynamic import.
 */
export const parseWorksheet = (ws: WorkSheet, utils: Utils): ParsedSheet => {
  const range = utils.decode_range(ws['!ref'] || 'A1');
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
      const cellAddress = utils.encode_cell({ r, c });
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

  const parseFile = useCallback(async (file: File, preferredSheet?: string | null): Promise<void> => {
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

      // Module-level promise singleton prevents concurrent parseFile calls from
      // issuing two separate dynamic imports before the first one resolves.
      // xlsx becomes a separate async chunk — NOT in the entry bundle.
      if (!xlsxPromise) xlsxPromise = import('xlsx');
      const XLSX = await xlsxPromise;
      // Persist the resolved module so synchronous selectSheet can use it.
      xlsxModule = XLSX;

      const arrayBuffer = await file.arrayBuffer();
      const wb = XLSX.read(arrayBuffer, { type: 'array', cellDates: true, cellNF: false, cellText: true });

      setWorkbook(wb);
      setSheets(wb.SheetNames);

      if (wb.SheetNames.length > 0) {
        const nextSheet = preferredSheet && wb.SheetNames.includes(preferredSheet)
          ? preferredSheet
          : wb.SheetNames[0];
        setSelectedSheet(nextSheet);
        const ws = wb.Sheets[nextSheet];
        const parsed = parseWorksheet(ws, XLSX.utils);
        parsed.name = nextSheet;
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

  // selectSheet is intentionally synchronous (public API unchanged).
  // The module-level xlsxModule is populated by parseFile before any sheet
  // selection can occur, so the guard below is only a safety net.
  // Note: selectSheet is not independently unit-tested here because it
  // requires renderHook from @testing-library/react (not used in this suite);
  // its parse logic is fully covered via the exported parseWorksheet tests.
  const selectSheet = useCallback((sheetName: string): void => {
    if (!workbook || !workbook.SheetNames.includes(sheetName)) return;
    if (!xlsxModule) return; // safety net: parseFile must run before selectSheet

    setSelectedSheet(sheetName);
    const ws = workbook.Sheets[sheetName];
    const parsed = parseWorksheet(ws, xlsxModule.utils);
    parsed.name = sheetName;
    setSheetData(parsed);
  }, [workbook]);

  const restoreWorkbook = useCallback((restored: WorkBook, sheetName?: string | null): boolean => {
    if (!xlsxModule || restored.SheetNames.length === 0) return false;
    const nextSheet = sheetName && restored.SheetNames.includes(sheetName)
      ? sheetName
      : restored.SheetNames[0];
    setWorkbook(restored);
    setSheets(restored.SheetNames);
    setSelectedSheet(nextSheet);
    const parsed = parseWorksheet(restored.Sheets[nextSheet], xlsxModule.utils);
    parsed.name = nextSheet;
    setSheetData(parsed);
    setIsLoading(false);
    setError(null);
    return true;
  }, []);

  const reset = useCallback((): void => {
    setWorkbook(null);
    setSheets([]);
    setSelectedSheet(null);
    setSheetData(null);
    setIsLoading(false);
    setError(null);
    // Note: xlsxPromise/xlsxModule are intentionally NOT cleared — keeping the
    // loaded module cached avoids a re-download on subsequent use within the
    // same session.
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
    restoreWorkbook,
    reset,
  };
};
