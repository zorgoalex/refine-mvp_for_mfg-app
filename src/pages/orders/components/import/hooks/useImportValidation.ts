// Hook for validating and transforming import data

import { useState, useCallback, useMemo } from 'react';
import type {
  ImportRow,
  ValidatedRow,
  FieldError,
  ReferenceData,
  ReferenceItem,
  FieldMapping,
  CellValue,
  ParsedSheet,
  SelectionRange,
} from '../types/importTypes';
import { getColumnIndex, IMPORT_DEFAULTS } from '../types/importTypes';

export interface UseImportValidationReturn {
  // State
  rows: ValidatedRow[];
  hasErrors: boolean;
  errorCount: number;
  warningCount: number;

  // Actions
  extractAndValidate: (
    sheetData: ParsedSheet,
    ranges: SelectionRange[],
    mapping: FieldMapping,
    hasHeaderRow: boolean,
    referenceData: ReferenceData
  ) => void;
  updateRow: (index: number, field: keyof ImportRow, value: any) => void;
  revalidate: (referenceData: ReferenceData) => void;
  reset: () => void;

  // Getters
  getValidRows: () => ValidatedRow[];
}

/**
 * Normalize a selection range
 */
const normalizeSelectionRange = (range: SelectionRange) => ({
  minRow: Math.min(range.startRow, range.endRow),
  maxRow: Math.max(range.startRow, range.endRow),
  minCol: Math.min(range.startCol, range.endCol),
  maxCol: Math.max(range.startCol, range.endCol),
});

/**
 * Parse a cell value as number
 */
const parseNumber = (value: CellValue): number | null => {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'string') {
    // Remove spaces and replace comma with dot
    const cleaned = value.replace(/\s/g, '').replace(',', '.');
    const num = parseFloat(cleaned);
    return isNaN(num) ? null : num;
  }
  return null;
};

/**
 * Parse a cell value as string
 */
const parseString = (value: CellValue): string | null => {
  if (value === null || value === undefined) {
    return null;
  }
  return String(value).trim() || null;
};

/**
 * Find a reference item by name (case-insensitive, partial match)
 */
const findReference = (name: string | null, items: ReferenceItem[]): number | null => {
  if (!name) return null;

  const normalized = name.toLowerCase().trim();

  // Try exact match first
  const exact = items.find(item => item.name.toLowerCase() === normalized);
  if (exact) return exact.id;

  // Try partial match (name contains search term or vice versa)
  const partial = items.find(
    item =>
      item.name.toLowerCase().includes(normalized) ||
      normalized.includes(item.name.toLowerCase())
  );
  if (partial) return partial.id;

  return null;
};

/**
 * Validate a single row
 */
const validateRow = (row: ImportRow, referenceData: ReferenceData): ValidatedRow => {
  const errors: FieldError[] = [];
  const warnings: FieldError[] = [];

  // Resolve references
  const edge_type_id = row.edgeTypeName
    ? findReference(row.edgeTypeName, referenceData.edgeTypes)
    : null;
  const film_id = row.filmName
    ? findReference(row.filmName, referenceData.films)
    : null;
  const material_id = row.materialName
    ? findReference(row.materialName, referenceData.materials)
    : null;
  const milling_type_id = row.millingTypeName
    ? findReference(row.millingTypeName, referenceData.millingTypes)
    : null;

  // Validate required fields
  if (row.height === null || row.height === undefined) {
    errors.push({ field: 'height', message: 'Высота обязательна', type: 'error' });
  } else if (row.height <= 0) {
    errors.push({ field: 'height', message: 'Высота должна быть больше 0', type: 'error' });
  } else if (row.height > 3000) {
    warnings.push({ field: 'height', message: 'Высота превышает 3000 мм', type: 'warning' });
  }

  if (row.width === null || row.width === undefined) {
    errors.push({ field: 'width', message: 'Ширина обязательна', type: 'error' });
  } else if (row.width <= 0) {
    errors.push({ field: 'width', message: 'Ширина должна быть больше 0', type: 'error' });
  } else if (row.width > 1500) {
    warnings.push({ field: 'width', message: 'Ширина превышает 1500 мм', type: 'warning' });
  }

  if (row.quantity === null || row.quantity === undefined) {
    errors.push({ field: 'quantity', message: 'Количество обязательно', type: 'error' });
  } else if (row.quantity <= 0) {
    errors.push({ field: 'quantity', message: 'Количество должно быть больше 0', type: 'error' });
  } else if (!Number.isInteger(row.quantity)) {
    warnings.push({ field: 'quantity', message: 'Количество округлено до целого', type: 'warning' });
  }

  // Warn about unresolved references
  if (row.edgeTypeName && !edge_type_id) {
    warnings.push({
      field: 'edgeTypeName',
      message: `Обкатка "${row.edgeTypeName}" не найдена`,
      type: 'warning',
    });
  }

  if (row.filmName && !film_id) {
    warnings.push({
      field: 'filmName',
      message: `Плёнка "${row.filmName}" не найдена`,
      type: 'warning',
    });
  }

  return {
    ...row,
    edge_type_id,
    film_id,
    material_id,
    milling_type_id,
    isValid: errors.length === 0,
    errors,
    warnings,
  };
};

/**
 * Hook for validating import data
 */
export const useImportValidation = (): UseImportValidationReturn => {
  const [rows, setRows] = useState<ValidatedRow[]>([]);
  const [referenceDataCache, setReferenceDataCache] = useState<ReferenceData | null>(null);

  /**
   * Count of errors and warnings
   */
  const { hasErrors, errorCount, warningCount } = useMemo(() => {
    let errorCount = 0;
    let warningCount = 0;

    for (const row of rows) {
      errorCount += row.errors.length;
      warningCount += row.warnings.length;
    }

    return {
      hasErrors: errorCount > 0,
      errorCount,
      warningCount,
    };
  }, [rows]);

  /**
   * Extract data from sheet and validate
   */
  const extractAndValidate = useCallback((
    sheetData: ParsedSheet,
    ranges: SelectionRange[],
    mapping: FieldMapping,
    hasHeaderRow: boolean,
    referenceData: ReferenceData
  ): void => {
    setReferenceDataCache(referenceData);

    const importRows: ImportRow[] = [];

    // Process each range
    for (const range of ranges) {
      const { minRow, maxRow, minCol, maxCol } = normalizeSelectionRange(range);

      // Start row (skip header if needed)
      const dataStartRow = hasHeaderRow ? minRow + 1 : minRow;

      // Extract rows from this range
      for (let rowIdx = dataStartRow; rowIdx <= maxRow; rowIdx++) {
        const excelRow = sheetData.data[rowIdx];
        if (!excelRow) continue;

        // Check if row is empty (all mapped cells are empty)
        let isEmpty = true;

        const importRow: ImportRow = {
          sourceRowIndex: rowIdx,
        };

        // Extract values based on mapping
        if (mapping.height) {
          const colIdx = getColumnIndex(mapping.height);
          if (colIdx >= minCol && colIdx <= maxCol) {
            const value = parseNumber(excelRow[colIdx]);
            if (value !== null) isEmpty = false;
            importRow.height = value;
          }
        }

        if (mapping.width) {
          const colIdx = getColumnIndex(mapping.width);
          if (colIdx >= minCol && colIdx <= maxCol) {
            const value = parseNumber(excelRow[colIdx]);
            if (value !== null) isEmpty = false;
            importRow.width = value;
          }
        }

        if (mapping.quantity) {
          const colIdx = getColumnIndex(mapping.quantity);
          if (colIdx >= minCol && colIdx <= maxCol) {
            const value = parseNumber(excelRow[colIdx]);
            if (value !== null) isEmpty = false;
            importRow.quantity = value !== null ? Math.round(value) : null;
          }
        }

        if (mapping.edge_type) {
          const colIdx = getColumnIndex(mapping.edge_type);
          if (colIdx >= minCol && colIdx <= maxCol) {
            importRow.edgeTypeName = parseString(excelRow[colIdx]);
          }
        }

        if (mapping.film) {
          const colIdx = getColumnIndex(mapping.film);
          if (colIdx >= minCol && colIdx <= maxCol) {
            importRow.filmName = parseString(excelRow[colIdx]);
          }
        }

        if (mapping.material) {
          const colIdx = getColumnIndex(mapping.material);
          if (colIdx >= minCol && colIdx <= maxCol) {
            importRow.materialName = parseString(excelRow[colIdx]);
          }
        }

        if (mapping.milling_type) {
          const colIdx = getColumnIndex(mapping.milling_type);
          if (colIdx >= minCol && colIdx <= maxCol) {
            importRow.millingTypeName = parseString(excelRow[colIdx]);
          }
        }

        if (mapping.note) {
          const colIdx = getColumnIndex(mapping.note);
          if (colIdx >= minCol && colIdx <= maxCol) {
            importRow.note = parseString(excelRow[colIdx]);
          }
        }

        if (mapping.detail_name) {
          const colIdx = getColumnIndex(mapping.detail_name);
          if (colIdx >= minCol && colIdx <= maxCol) {
            importRow.detailName = parseString(excelRow[colIdx]);
          }
        }

        // Skip empty rows
        if (!isEmpty) {
          importRows.push(importRow);
        }
      }
    }

    // Validate all rows
    const validatedRows = importRows.map(row => validateRow(row, referenceData));
    setRows(validatedRows);
  }, []);

  /**
   * Update a single row value
   */
  const updateRow = useCallback((index: number, field: keyof ImportRow, value: any): void => {
    setRows(prev => {
      const updated = [...prev];
      if (updated[index]) {
        const updatedRow = { ...updated[index], [field]: value };

        // Re-validate if we have cached reference data
        if (referenceDataCache) {
          const revalidated = validateRow(updatedRow, referenceDataCache);
          updated[index] = revalidated;
        } else {
          updated[index] = updatedRow as ValidatedRow;
        }
      }
      return updated;
    });
  }, [referenceDataCache]);

  /**
   * Revalidate all rows with new reference data
   */
  const revalidate = useCallback((referenceData: ReferenceData): void => {
    setReferenceDataCache(referenceData);
    setRows(prev => prev.map(row => validateRow(row, referenceData)));
  }, []);

  /**
   * Reset all state
   */
  const reset = useCallback((): void => {
    setRows([]);
    setReferenceDataCache(null);
  }, []);

  /**
   * Get only valid rows
   */
  const getValidRows = useCallback((): ValidatedRow[] => {
    return rows.filter(row => row.isValid);
  }, [rows]);

  return {
    rows,
    hasErrors,
    errorCount,
    warningCount,
    extractAndValidate,
    updateRow,
    revalidate,
    reset,
    getValidRows,
  };
};
