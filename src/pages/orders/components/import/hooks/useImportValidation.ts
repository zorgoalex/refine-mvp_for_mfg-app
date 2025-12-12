// Hook for validating and resolving import data

import { useState, useCallback, useMemo } from 'react';
import type {
  ParsedSheet,
  SelectionRange,
  FieldMapping,
  ImportRow,
  ValidatedRow,
  ReferenceData,
  ReferenceItem,
  FieldError,
  NormalizedRange,
  ImportableField,
} from '../types/importTypes';
import { FIELD_CONFIGS, FIELD_KEYWORDS, IMPORT_DEFAULTS } from '../types/importTypes';

export interface UseImportValidationReturn {
  validatedRows: ValidatedRow[];
  referenceData: ReferenceData;
  isLoading: boolean;
  stats: ImportStats;
  setReferenceData: (data: ReferenceData) => void;
  processImport: (sheet: ParsedSheet, ranges: SelectionRange[], mapping: FieldMapping, hasHeaders: boolean) => void;
  updateRow: (index: number, field: keyof ValidatedRow, value: unknown) => void;
  removeRow: (index: number) => void;
  getValidRows: () => ValidatedRow[];
  reset: () => void;
  autoDetectMapping: (sheet: ParsedSheet, range: SelectionRange, hasHeaders: boolean) => FieldMapping;
}

export interface ImportStats {
  totalRows: number;
  validRows: number;
  errorRows: number;
  warningRows: number;
  totalQuantity: number;
  totalArea: number;
}

const normalizeRange = (range: SelectionRange): NormalizedRange => ({
  minRow: Math.min(range.startRow, range.endRow),
  maxRow: Math.max(range.startRow, range.endRow),
  minCol: Math.min(range.startCol, range.endCol),
  maxCol: Math.max(range.startCol, range.endCol),
});

const emptyMapping = (): FieldMapping => ({
  height: null,
  width: null,
  quantity: null,
  edge_type: null,
  film: null,
  material: null,
  milling_type: null,
  note: null,
  detail_name: null,
});

const findReferenceId = (name: string | null | undefined, items: ReferenceItem[]): number | null => {
  if (!name) return null;
  const normalizedName = String(name).toLowerCase().trim();
  const found = items.find(item => item.name.toLowerCase().trim() === normalizedName);
  if (found) return found.id;
  // Fuzzy match: check if name includes or is included
  const fuzzy = items.find(item =>
    item.name.toLowerCase().includes(normalizedName) ||
    normalizedName.includes(item.name.toLowerCase())
  );
  return fuzzy?.id || null;
};

export const useImportValidation = (): UseImportValidationReturn => {
  const [validatedRows, setValidatedRows] = useState<ValidatedRow[]>([]);
  const [referenceData, setReferenceData] = useState<ReferenceData>({
    edgeTypes: [],
    films: [],
    materials: [],
    millingTypes: [],
  });
  const [isLoading, setIsLoading] = useState(false);

  const stats = useMemo((): ImportStats => {
    let totalQuantity = 0;
    let totalArea = 0;
    let validRows = 0;
    let errorRows = 0;
    let warningRows = 0;

    for (const row of validatedRows) {
      if (row.isValid) {
        validRows++;
        const qty = row.quantity || 0;
        const h = row.height || 0;
        const w = row.width || 0;
        totalQuantity += qty;
        totalArea += (h * w * qty) / 1000000; // mm² to m²
      } else if (row.errors.length > 0) {
        errorRows++;
      }
      if (row.warnings.length > 0) {
        warningRows++;
      }
    }

    return {
      totalRows: validatedRows.length,
      validRows,
      errorRows,
      warningRows,
      totalQuantity,
      totalArea: Math.round(totalArea * 100) / 100,
    };
  }, [validatedRows]);

  const autoDetectMapping = useCallback((
    sheet: ParsedSheet,
    range: SelectionRange,
    hasHeaders: boolean
  ): FieldMapping => {
    const mapping = emptyMapping();
    if (!hasHeaders) return mapping;

    const { minRow, minCol, maxCol } = normalizeRange(range);
    const headerRow = sheet.data[minRow];
    if (!headerRow) return mapping;

    for (let col = minCol; col <= maxCol; col++) {
      const cellValue = headerRow[col];
      if (!cellValue) continue;
      const headerText = String(cellValue).toLowerCase().trim();

      for (const [field, keywords] of Object.entries(FIELD_KEYWORDS)) {
        if (mapping[field as ImportableField]) continue; // Already mapped
        for (const keyword of keywords) {
          if (headerText.includes(keyword)) {
            mapping[field as ImportableField] = sheet.headers[col];
            break;
          }
        }
      }
    }

    return mapping;
  }, []);

  const processImport = useCallback((
    sheet: ParsedSheet,
    ranges: SelectionRange[],
    mapping: FieldMapping,
    hasHeaders: boolean
  ): void => {
    setIsLoading(true);

    try {
      const allRows: ImportRow[] = [];

      for (const range of ranges) {
        const { minRow, maxRow, minCol, maxCol } = normalizeRange(range);
        const dataStartRow = hasHeaders ? minRow + 1 : minRow;

        // Build column index map from letters
        const colMap: Record<string, number> = {};
        for (let c = minCol; c <= maxCol; c++) {
          colMap[sheet.headers[c]] = c;
        }

        for (let r = dataStartRow; r <= maxRow; r++) {
          const row = sheet.data[r];
          if (!row) continue;

          const getVal = (colLetter: string | null): unknown => {
            if (!colLetter) return null;
            const colIdx = colMap[colLetter];
            return colIdx !== undefined ? row[colIdx] : null;
          };

          const importRow: ImportRow = {
            sourceRowIndex: r,
            height: getVal(mapping.height) as number | null,
            width: getVal(mapping.width) as number | null,
            quantity: getVal(mapping.quantity) as number | null,
            edgeTypeName: getVal(mapping.edge_type) as string | null,
            filmName: getVal(mapping.film) as string | null,
            materialName: getVal(mapping.material) as string | null,
            millingTypeName: getVal(mapping.milling_type) as string | null,
            note: getVal(mapping.note) as string | null,
            detailName: getVal(mapping.detail_name) as string | null,
          };

          // Skip empty rows
          if (!importRow.height && !importRow.width && !importRow.quantity) continue;

          allRows.push(importRow);
        }
      }

      // Validate and resolve references
      const validated: ValidatedRow[] = allRows.map(row => {
        const errors: FieldError[] = [];
        const warnings: FieldError[] = [];

        // Validate required fields
        const height = Number(row.height);
        const width = Number(row.width);
        const quantity = Number(row.quantity);

        if (!row.height || isNaN(height) || height <= 0) {
          errors.push({ field: 'height', message: 'Требуется высота > 0', type: 'error' });
        }
        if (!row.width || isNaN(width) || width <= 0) {
          errors.push({ field: 'width', message: 'Требуется ширина > 0', type: 'error' });
        }
        if (!row.quantity || isNaN(quantity) || quantity <= 0) {
          errors.push({ field: 'quantity', message: 'Требуется количество > 0', type: 'error' });
        }

        // Resolve references
        const edge_type_id = findReferenceId(row.edgeTypeName, referenceData.edgeTypes);
        const film_id = findReferenceId(row.filmName, referenceData.films);
        const material_id = findReferenceId(row.materialName, referenceData.materials);
        const milling_type_id = findReferenceId(row.millingTypeName, referenceData.millingTypes);

        // Warnings for unresolved references
        if (row.edgeTypeName && !edge_type_id) {
          warnings.push({ field: 'edge_type', message: `Не найдена обкатка: "${row.edgeTypeName}"`, type: 'warning' });
        }
        if (row.filmName && !film_id) {
          warnings.push({ field: 'film', message: `Не найдена плёнка: "${row.filmName}"`, type: 'warning' });
        }
        if (row.materialName && !material_id) {
          warnings.push({ field: 'material', message: `Не найден материал: "${row.materialName}"`, type: 'warning' });
        }
        if (row.millingTypeName && !milling_type_id) {
          warnings.push({ field: 'milling_type', message: `Не найдена фрезеровка: "${row.millingTypeName}"`, type: 'warning' });
        }

        return {
          ...row,
          height: isNaN(height) ? null : height,
          width: isNaN(width) ? null : width,
          quantity: isNaN(quantity) ? null : quantity,
          edge_type_id,
          film_id,
          material_id,
          milling_type_id,
          isValid: errors.length === 0,
          errors,
          warnings,
        };
      });

      setValidatedRows(validated);
    } finally {
      setIsLoading(false);
    }
  }, [referenceData]);

  const updateRow = useCallback((index: number, field: keyof ValidatedRow, value: unknown): void => {
    setValidatedRows(prev => {
      const updated = [...prev];
      const row = { ...updated[index], [field]: value };

      // Re-validate after update
      const errors: FieldError[] = [];
      const height = Number(row.height);
      const width = Number(row.width);
      const quantity = Number(row.quantity);

      if (!row.height || isNaN(height) || height <= 0) {
        errors.push({ field: 'height', message: 'Требуется высота > 0', type: 'error' });
      }
      if (!row.width || isNaN(width) || width <= 0) {
        errors.push({ field: 'width', message: 'Требуется ширина > 0', type: 'error' });
      }
      if (!row.quantity || isNaN(quantity) || quantity <= 0) {
        errors.push({ field: 'quantity', message: 'Требуется количество > 0', type: 'error' });
      }

      row.errors = errors;
      row.isValid = errors.length === 0;
      updated[index] = row;
      return updated;
    });
  }, []);

  const removeRow = useCallback((index: number): void => {
    setValidatedRows(prev => prev.filter((_, i) => i !== index));
  }, []);

  const getValidRows = useCallback((): ValidatedRow[] => {
    return validatedRows.filter(row => row.isValid);
  }, [validatedRows]);

  const reset = useCallback((): void => {
    setValidatedRows([]);
    setIsLoading(false);
  }, []);

  return {
    validatedRows,
    referenceData,
    isLoading,
    stats,
    setReferenceData,
    processImport,
    updateRow,
    removeRow,
    getValidRows,
    reset,
    autoDetectMapping,
  };
};
