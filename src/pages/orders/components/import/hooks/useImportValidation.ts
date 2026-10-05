// Hook for validating and resolving import data

import { useState, useCallback, useEffect, useMemo } from 'react';
import type {
  ParsedSheet,
  SelectionRange,
  FieldMapping,
  ImportRow,
  ValidatedRow,
  ReferenceData,
  ReferenceItem,
  SheetMaterialReferenceItem,
  FieldError,
  NormalizedRange,
  ImportableField,
} from '../types/importTypes';
import { FIELD_CONFIGS, FIELD_KEYWORDS, IMPORT_DEFAULTS } from '../types/importTypes';
import { calculateOrderTotalArea } from '../../../../../utils/orderArea';
import { detectOrderExport, extractImportRows } from '../orderExportDetection';
import { resolveFilmName } from '../utils/filmNameResolution';

export interface UnresolvedReference {
  originalValue: string;
  count: number;
  field: 'edge_type' | 'film' | 'material' | 'milling_type';
  nameField: 'edgeTypeName' | 'filmName' | 'materialName' | 'millingTypeName';
  idField: 'edge_type_id' | 'film_id' | 'material_id' | 'sheet_material_type_id' | 'milling_type_id';
}

export interface UnresolvedReferences {
  edgeTypes: UnresolvedReference[];
  films: UnresolvedReference[];
  materials: UnresolvedReference[];
  millingTypes: UnresolvedReference[];
}

export interface UseImportValidationReturn {
  validatedRows: ValidatedRow[];
  referenceData: ReferenceData;
  isLoading: boolean;
  /** Индекс названий плёнок ещё загружается, а в строках есть отложенные плёнки — импорт ждать. */
  filmIndexLoading: boolean;
  stats: ImportStats;
  unresolvedRefs: UnresolvedReferences;
  setReferenceData: (data: ReferenceData) => void;
  processImport: (sheet: ParsedSheet, ranges: SelectionRange[], mapping: FieldMapping, hasHeaders: boolean) => void;
  processDirectRows: (rows: ImportRow[]) => void;
  updateRow: (index: number, field: keyof ValidatedRow, value: unknown) => void;
  removeRow: (index: number) => void;
  getValidRows: () => ValidatedRow[];
  reset: () => void;
  restoreValidatedRows: (rows: ValidatedRow[]) => void;
  autoDetectMapping: (sheet: ParsedSheet, range: SelectionRange, hasHeaders: boolean) => FieldMapping;
  batchReplaceReference: (field: 'edge_type' | 'film' | 'material' | 'milling_type', originalValue: string, newId: number) => void;
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

export const normalizeReferenceName = (value: string): string =>
  value
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/\s+/g, ' ')
    .trim();

const compactReferenceName = (value: string): string =>
  normalizeReferenceName(value).replace(/\s+/g, '');

export const findReferenceId = (name: string | null | undefined, items: ReferenceItem[]): number | null => {
  if (!name) return null;
  const normalizedName = normalizeReferenceName(String(name));
  if (!normalizedName) return null;
  const compactName = compactReferenceName(normalizedName);

  // Exact match first
  const found = items.find(item =>
    normalizeReferenceName(item.name) === normalizedName ||
    compactReferenceName(item.name) === compactName
  );
  if (found) return found.id;

  // Fuzzy match only for longer strings (at least 3 chars) to avoid false positives
  if (normalizedName.length >= 3) {
    const fuzzy = items.find(item => {
      const itemName = normalizeReferenceName(item.name);
      const compactItemName = compactReferenceName(item.name);
      // Only match if search term is substantial part of item name or vice versa
      return (itemName.includes(normalizedName) && normalizedName.length >= itemName.length * 0.5) ||
             (normalizedName.includes(itemName) && itemName.length >= normalizedName.length * 0.5) ||
             (compactItemName.includes(compactName) && compactName.length >= compactItemName.length * 0.5) ||
             (compactName.includes(compactItemName) && compactItemName.length >= compactName.length * 0.5);
    });
    return fuzzy?.id || null;
  }

  return null;
};

export interface FilmReferenceResult {
  filmId: number | null;
  ambiguous: boolean;
  /** Индекс прежних названий не готов — плёнка не подставлена автоматически. */
  pendingIndex: boolean;
}

export const resolveFilmReference = (
  name: string | null | undefined,
  referenceData: ReferenceData,
): FilmReferenceResult => {
  const status = referenceData.filmNameIndexStatus ?? 'ready';
  // Без полного индекса текущее имя одной плёнки может оказаться прежним именем другой:
  // автоматический выбор откладывается до загрузки индекса, иначе — ручной выбор.
  if (name && String(name).trim() && status !== 'ready') return { filmId: null, ambiguous: false, pendingIndex: true };
  const resolution = resolveFilmName(name, referenceData.films, referenceData.filmNameIndex ?? []);
  if (resolution.status === 'matched') return { filmId: resolution.filmId, ambiguous: false, pendingIndex: false };
  if (resolution.status === 'ambiguous') return { filmId: null, ambiguous: true, pendingIndex: false };
  // Keep legacy fuzzy matching when the index has no exact hit.
  return { filmId: findReferenceId(name, referenceData.films), ambiguous: false, pendingIndex: false };
};

export const filmResolutionWarning = (
  name: string | null | undefined,
  resolution: FilmReferenceResult,
  referenceData: ReferenceData,
): FieldError | null => {
  if (!name || resolution.filmId) return null;
  if (resolution.pendingIndex) {
    return {
      field: 'film',
      type: 'warning',
      message: referenceData.filmNameIndexStatus === 'unavailable'
        ? `Не удалось проверить прежние названия плёнок — выберите плёнку для "${name}" вручную`
        : `Проверяются прежние названия плёнок для "${name}" — плёнка будет подставлена после проверки`,
    };
  }
  return {
    field: 'film',
    type: 'warning',
    message: resolution.ambiguous
      ? `Найдено несколько канонических плёнок для "${name}". Выберите вручную.`
      : `Не найдена плёнка: "${name}"`,
  };
};

const sameWarnings = (left: FieldError[], right: FieldError[]): boolean =>
  left.length === right.length
  && left.every((warning, index) => warning.field === right[index].field && warning.message === right[index].message);

/**
 * Пересчитывает плёнку строк, отложенных до загрузки индекса. Строки с выбранной
 * плёнкой или ручным решением не трогаются. Без изменений возвращает тот же массив.
 */
export const refreshPendingFilmRows = (rows: ValidatedRow[], referenceData: ReferenceData): ValidatedRow[] => {
  let changed = false;
  const next = rows.map((row) => {
    if (!row.filmPendingIndex || row.film_id || !row.filmName) return row;
    const resolution = resolveFilmReference(row.filmName, referenceData);
    const warning = filmResolutionWarning(row.filmName, resolution, referenceData);
    const warnings = [...row.warnings.filter((item) => item.field !== 'film'), ...(warning ? [warning] : [])];
    if (resolution.filmId === null && resolution.pendingIndex && sameWarnings(warnings, row.warnings)) return row;
    changed = true;
    return { ...row, film_id: resolution.filmId, filmPendingIndex: resolution.pendingIndex, warnings };
  });
  return changed ? next : rows;
};

/** Partial reference context for pure row resolution (used in tests and internally). */
export interface ResolveImportRowRefs {
  sheetMaterialTypes?: SheetMaterialReferenceItem[];
}

/**
 * Pure helper: resolves a single partial ImportRow's materialName against
 * sheet_material_types (cuttable types only, per Critic R21 B1) and returns
 * the resolved ids. Used both internally and in unit tests.
 */
export function resolveImportRow(
  row: Partial<ImportRow>,
  refs: ResolveImportRowRefs,
): { sheet_material_type_id: number | null; material_id: null } {
  const cuttableTypes = (refs.sheetMaterialTypes ?? []).filter(
    (t) => t.isCuttable !== false,
  );
  const sheet_material_type_id = findReferenceId(
    row.materialName ?? null,
    cuttableTypes,
  );
  return { sheet_material_type_id, material_id: null };
}

export const useImportValidation = (): UseImportValidationReturn => {
  const [validatedRows, setValidatedRows] = useState<ValidatedRow[]>([]);
  const [referenceData, setReferenceData] = useState<ReferenceData>({
    edgeTypes: [],
    films: [],
    // Справочники модалки ещё не переданы: отложенные плёнки (в т.ч. из восстановленного
    // черновика) ждут, а не разрешаются по пустым данным.
    filmNameIndexStatus: 'loading',
    materials: [],
    millingTypes: [],
    sheetMaterialTypes: [],
  });
  const [isLoading, setIsLoading] = useState(false);

  const stats = useMemo((): ImportStats => {
    let totalQuantity = 0;
    let validRows = 0;
    let errorRows = 0;
    let warningRows = 0;

    for (const row of validatedRows) {
      if (row.isValid) {
        validRows++;
        const qty = row.quantity || 0;
        totalQuantity += qty;
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
      totalArea: calculateOrderTotalArea(validatedRows.filter((row) => row.isValid)),
    };
  }, [validatedRows]);

  // Индекс прежних названий плёнок загрузился (или стал недоступен) после разбора строк:
  // пересчитать только отложенные автоматические сопоставления.
  useEffect(() => {
    setValidatedRows((prev) => refreshPendingFilmRows(prev, referenceData));
  }, [referenceData]);

  const filmIndexLoading = referenceData.filmNameIndexStatus === 'loading'
    && validatedRows.some((row) => row.filmPendingIndex && !row.film_id);

  // Get unresolved references grouped by type
  const unresolvedRefs = useMemo((): UnresolvedReferences => {
    const countMap = {
      edgeTypes: new Map<string, number>(),
      films: new Map<string, number>(),
      materials: new Map<string, number>(),
      millingTypes: new Map<string, number>(),
    };

    for (const row of validatedRows) {
      if (row.edgeTypeName && !row.edge_type_id) {
        const key = String(row.edgeTypeName).trim();
        countMap.edgeTypes.set(key, (countMap.edgeTypes.get(key) || 0) + 1);
      }
      if (row.filmName && !row.film_id) {
        const key = String(row.filmName).trim();
        countMap.films.set(key, (countMap.films.get(key) || 0) + 1);
      }
      if (row.materialName && !row.sheet_material_type_id) {
        const key = String(row.materialName).trim();
        countMap.materials.set(key, (countMap.materials.get(key) || 0) + 1);
      }
      if (row.millingTypeName && !row.milling_type_id) {
        const key = String(row.millingTypeName).trim();
        countMap.millingTypes.set(key, (countMap.millingTypes.get(key) || 0) + 1);
      }
    }

    return {
      edgeTypes: Array.from(countMap.edgeTypes.entries()).map(([originalValue, count]) => ({
        originalValue,
        count,
        field: 'edge_type' as const,
        nameField: 'edgeTypeName' as const,
        idField: 'edge_type_id' as const,
      })),
      films: Array.from(countMap.films.entries()).map(([originalValue, count]) => ({
        originalValue,
        count,
        field: 'film' as const,
        nameField: 'filmName' as const,
        idField: 'film_id' as const,
      })),
      materials: Array.from(countMap.materials.entries()).map(([originalValue, count]) => ({
        originalValue,
        count,
        field: 'material' as const,
        nameField: 'materialName' as const,
        idField: 'sheet_material_type_id' as const,
      })),
      millingTypes: Array.from(countMap.millingTypes.entries()).map(([originalValue, count]) => ({
        originalValue,
        count,
        field: 'milling_type' as const,
        nameField: 'millingTypeName' as const,
        idField: 'milling_type_id' as const,
      })),
    };
  }, [validatedRows]);

  // Batch replace reference across all rows
  const batchReplaceReference = useCallback((
    field: 'edge_type' | 'film' | 'material' | 'milling_type',
    originalValue: string,
    newId: number
  ): void => {
    const fieldMap = {
      edge_type: { nameField: 'edgeTypeName', idField: 'edge_type_id' },
      film: { nameField: 'filmName', idField: 'film_id' },
      // Variant B: material resolves to sheet_material_type_id, not material_id
      material: { nameField: 'materialName', idField: 'sheet_material_type_id' },
      milling_type: { nameField: 'millingTypeName', idField: 'milling_type_id' },
    };

    const { nameField, idField } = fieldMap[field];

    setValidatedRows(prev => prev.map(row => {
      const rowNameValue = row[nameField as keyof ValidatedRow];
      if (rowNameValue && String(rowNameValue).trim() === originalValue && !row[idField as keyof ValidatedRow]) {
        // Update the row and remove the warning for this field
        const newWarnings = row.warnings.filter(w => w.field !== field);
        return {
          ...row,
          [idField]: newId,
          ...(field === 'film' ? { filmPendingIndex: false } : {}),
          warnings: newWarnings,
        };
      }
      return row;
    }));
  }, []);

  const autoDetectMapping = useCallback((
    sheet: ParsedSheet,
    range: SelectionRange,
    hasHeaders: boolean
  ): FieldMapping => {
    const exported = detectOrderExport(sheet);
    if (exported && hasHeaders && Math.min(range.startRow, range.endRow) === exported.range.startRow) {
      const minCol = Math.min(range.startCol, range.endCol);
      const maxCol = Math.max(range.startCol, range.endCol);
      return Object.fromEntries(Object.entries(exported.mapping).map(([field, column]) => [
        field, column && sheet.headers.indexOf(column) >= minCol && sheet.headers.indexOf(column) <= maxCol ? column : null,
      ])) as unknown as FieldMapping;
    }
    const mapping = emptyMapping();
    const { minRow, maxRow, minCol, maxCol } = normalizeRange(range);
    const dataStartRow = hasHeaders ? minRow + 1 : minRow;

    // If headers exist, first try keyword-based detection
    if (hasHeaders) {
      const headerRow = sheet.data[minRow];
      if (headerRow) {
        for (let col = minCol; col <= maxCol; col++) {
          const cellValue = headerRow[col];
          if (!cellValue) continue;
          const headerText = String(cellValue).toLowerCase().trim();

          for (const [field, keywords] of Object.entries(FIELD_KEYWORDS)) {
            if (mapping[field as ImportableField]) continue;
            for (const keyword of keywords) {
              if (headerText.includes(keyword)) {
                mapping[field as ImportableField] = sheet.headers[col];
                break;
              }
            }
          }
        }
      }
    }

    // Positional mapping for first 3 unmapped columns → height, width, quantity
    const positionalFields: ImportableField[] = ['height', 'width', 'quantity'];
    let positionalIndex = 0;

    for (let col = minCol; col <= maxCol && positionalIndex < positionalFields.length; col++) {
      const colLetter = sheet.headers[col];
      const field = positionalFields[positionalIndex];

      // Skip if this column already mapped or field already has mapping
      if (Object.values(mapping).includes(colLetter)) continue;
      if (mapping[field]) continue;

      // Check if column has numeric data
      let numericCount = 0;
      const sampleSize = Math.min(10, maxRow - dataStartRow + 1);
      for (let r = dataStartRow; r < dataStartRow + sampleSize && r <= maxRow; r++) {
        const val = sheet.data[r]?.[col];
        if (val != null && !isNaN(Number(val))) numericCount++;
      }

      if (numericCount >= sampleSize * 0.5) {
        mapping[field] = colLetter;
        positionalIndex++;
      }
    }

    // Content-based detection for reference fields
    // Variant B: material auto-detection uses sheetMaterialTypes (cuttable only)
    const refFields: { field: ImportableField; data: ReferenceItem[] }[] = [
      { field: 'edge_type', data: referenceData.edgeTypes },
      { field: 'material', data: (referenceData.sheetMaterialTypes ?? []).filter(t => t.isCuttable !== false) },
      { field: 'milling_type', data: referenceData.millingTypes },
      { field: 'film', data: referenceData.films },
    ];

    for (let col = minCol; col <= maxCol; col++) {
      const colLetter = sheet.headers[col];
      if (Object.values(mapping).includes(colLetter)) continue; // Already mapped

      // Sample values from this column
      const sampleValues: string[] = [];
      const sampleSize = Math.min(10, maxRow - dataStartRow + 1);
      for (let r = dataStartRow; r < dataStartRow + sampleSize && r <= maxRow; r++) {
        const val = sheet.data[r]?.[col];
        if (val != null && String(val).trim()) {
          sampleValues.push(String(val).toLowerCase().trim());
        }
      }

      if (sampleValues.length === 0) continue;

      // Check each reference field
      for (const { field, data } of refFields) {
        if (mapping[field]) continue; // Already mapped

        const refNames = data.map(item => item.name.toLowerCase().trim());
        let matchCount = 0;

        for (const val of sampleValues) {
          // Check if value matches or partially matches any reference name
          if (refNames.some(name => name.includes(val) || val.includes(name))) {
            matchCount++;
          }
        }

        // If >30% match, assign this field
        if (matchCount >= sampleValues.length * 0.3) {
          mapping[field] = colLetter;
          break;
        }
      }
    }

    // For remaining text columns, try to assign note or detail_name
    const textFields: ImportableField[] = ['detail_name', 'note'];
    for (let col = minCol; col <= maxCol; col++) {
      const colLetter = sheet.headers[col];
      if (Object.values(mapping).includes(colLetter)) continue;

      // Check if column has text data (not pure numbers)
      let textCount = 0;
      const sampleSize = Math.min(5, maxRow - dataStartRow + 1);
      for (let r = dataStartRow; r < dataStartRow + sampleSize && r <= maxRow; r++) {
        const val = sheet.data[r]?.[col];
        if (val != null && isNaN(Number(val)) && String(val).trim().length > 0) {
          textCount++;
        }
      }

      if (textCount >= sampleSize * 0.5) {
        for (const field of textFields) {
          if (!mapping[field]) {
            mapping[field] = colLetter;
            break;
          }
        }
      }
    }

    return mapping;
  }, [referenceData]);

  const processImport = useCallback((
    sheet: ParsedSheet,
    ranges: SelectionRange[],
    mapping: FieldMapping,
    hasHeaders: boolean
  ): void => {
    setIsLoading(true);

    try {
      const allRows = extractImportRows(sheet, ranges, mapping, hasHeaders);

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
        const filmResolution = resolveFilmReference(row.filmName, referenceData);
        const film_id = filmResolution.filmId;
        // Variant B: material resolves to sheet_material_type_id against cuttable types only
        const { sheet_material_type_id } = resolveImportRow(row, {
          sheetMaterialTypes: referenceData.sheetMaterialTypes,
        });
        const milling_type_id = findReferenceId(row.millingTypeName, referenceData.millingTypes);

        // Warnings for unresolved references
        if (row.edgeTypeName && !edge_type_id) {
          warnings.push({ field: 'edge_type', message: `Не найдена обкатка: "${row.edgeTypeName}"`, type: 'warning' });
        }
        const filmWarning = filmResolutionWarning(row.filmName, filmResolution, referenceData);
        if (filmWarning) warnings.push(filmWarning);
        if (row.materialName && !sheet_material_type_id) {
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
          filmPendingIndex: filmResolution.pendingIndex,
          material_id: null,
          sheet_material_type_id,
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

  // Process pre-parsed rows directly (for PDF import)
  const processDirectRows = useCallback((rows: ImportRow[]): void => {
    setIsLoading(true);

    try {
      const validated: ValidatedRow[] = rows.map(row => {
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
        const filmResolution = resolveFilmReference(row.filmName, referenceData);
        const film_id = filmResolution.filmId;
        // Variant B: material resolves to sheet_material_type_id against cuttable types only
        const { sheet_material_type_id } = resolveImportRow(row, {
          sheetMaterialTypes: referenceData.sheetMaterialTypes,
        });
        const milling_type_id = findReferenceId(row.millingTypeName, referenceData.millingTypes);

        // Warnings for unresolved references
        if (row.edgeTypeName && !edge_type_id) {
          warnings.push({ field: 'edge_type', message: `Не найдена обкатка: "${row.edgeTypeName}"`, type: 'warning' });
        }
        const filmWarning = filmResolutionWarning(row.filmName, filmResolution, referenceData);
        if (filmWarning) warnings.push(filmWarning);
        if (row.materialName && !sheet_material_type_id) {
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
          filmPendingIndex: filmResolution.pendingIndex,
          material_id: null,
          sheet_material_type_id,
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
      // Ручной выбор плёнки (в том числе очистка) не перезаписывается пересчётом по индексу.
      if (field === 'film_id') row.filmPendingIndex = false;

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

  const restoreValidatedRows = useCallback((rows: ValidatedRow[]): void => {
    setValidatedRows(rows);
    setIsLoading(false);
  }, []);

  return {
    validatedRows,
    referenceData,
    isLoading,
    filmIndexLoading,
    stats,
    unresolvedRefs,
    setReferenceData,
    processImport,
    processDirectRows,
    updateRow,
    removeRow,
    getValidRows,
    reset,
    restoreValidatedRows,
    autoDetectMapping,
    batchReplaceReference,
  };
};
