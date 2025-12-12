// Types for Excel Import functionality

import type { WorkBook, WorkSheet } from 'xlsx';

// ============================================================================
// EXCEL DATA TYPES
// ============================================================================

/** Raw cell value from Excel */
export type CellValue = string | number | boolean | Date | null | undefined;

/** Single row of Excel data (column letter -> value) */
export type ExcelRow = Record<string, CellValue>;

/** Parsed Excel sheet data */
export interface ParsedSheet {
  name: string;
  data: CellValue[][];
  headers: string[];  // Column letters: A, B, C...
  rowCount: number;
  colCount: number;
}

// ============================================================================
// SELECTION TYPES
// ============================================================================

/** Single cell position */
export interface CellPosition {
  row: number;  // 0-based row index
  col: number;  // 0-based column index
}

/** Selection range (multiple cells) */
export interface SelectionRange {
  id: string;
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
  color?: string;  // Visual highlight color
}

/** Normalized range (start <= end) */
export interface NormalizedRange {
  minRow: number;
  maxRow: number;
  minCol: number;
  maxCol: number;
}

// ============================================================================
// COLUMN MAPPING TYPES
// ============================================================================

/** Target fields for import (from OrderDetail) */
export type ImportableField =
  | 'height'
  | 'width'
  | 'quantity'
  | 'edge_type'    // Will be resolved to edge_type_id
  | 'film'         // Will be resolved to film_id
  | 'material'     // Optional: resolved to material_id
  | 'milling_type' // Optional: resolved to milling_type_id
  | 'note'
  | 'detail_name';

/** Column mapping configuration */
export interface ColumnMapping {
  [key: string]: ImportableField | null;  // Excel column letter -> field
}

/** Reverse mapping: field -> column letter */
export interface FieldMapping {
  height: string | null;
  width: string | null;
  quantity: string | null;
  edge_type: string | null;
  film: string | null;
  material: string | null;
  milling_type: string | null;
  note: string | null;
  detail_name: string | null;
}

/** Field configuration for mapping UI */
export interface FieldConfig {
  field: ImportableField;
  label: string;
  required: boolean;
  type: 'number' | 'text' | 'reference';
  referenceResource?: string;  // For reference fields: 'edge_types', 'films', etc.
}

// ============================================================================
// IMPORT ROW TYPES
// ============================================================================

/** Single row extracted from Excel */
export interface ImportRow {
  sourceRowIndex: number;  // Original row index in Excel (for highlighting)
  height?: number | null;
  width?: number | null;
  quantity?: number | null;
  edgeTypeName?: string | null;
  filmName?: string | null;
  materialName?: string | null;
  millingTypeName?: string | null;
  note?: string | null;
  detailName?: string | null;
}

/** Row after reference resolution */
export interface ResolvedRow extends ImportRow {
  edge_type_id?: number | null;
  film_id?: number | null;
  material_id?: number | null;
  milling_type_id?: number | null;
}

/** Validation error for a single field */
export interface FieldError {
  field: string;
  message: string;
  type: 'error' | 'warning';
}

/** Row with validation results */
export interface ValidatedRow extends ResolvedRow {
  isValid: boolean;
  errors: FieldError[];
  warnings: FieldError[];
}

// ============================================================================
// IMPORT STATE TYPES
// ============================================================================

/** Import wizard step */
export type ImportStep =
  | 'upload'      // Step 1: File upload and sheet selection
  | 'select'      // Step 2: Range selection
  | 'mapping'     // Step 3: Column mapping
  | 'validation'  // Step 4: Validation and editing
  | 'complete';   // Final: Import complete

/** Import mode */
export type ImportMode = 'new_order' | 'existing_order';

/** Full import state */
export interface ImportState {
  // Current step
  step: ImportStep;

  // File data
  workbook: WorkBook | null;
  sheets: string[];
  selectedSheet: string | null;
  sheetData: ParsedSheet | null;

  // Selection
  ranges: SelectionRange[];

  // Mapping
  fieldMapping: FieldMapping;
  hasHeaderRow: boolean;

  // Validation
  rows: ValidatedRow[];

  // Import mode
  mode: ImportMode;
  orderId?: number;

  // Status
  isLoading: boolean;
  error: string | null;
}

// ============================================================================
// REFERENCE DATA TYPES (for resolving names to IDs)
// ============================================================================

export interface ReferenceItem {
  id: number;
  name: string;
}

export interface ReferenceData {
  edgeTypes: ReferenceItem[];
  films: ReferenceItem[];
  materials: ReferenceItem[];
  millingTypes: ReferenceItem[];
}

// ============================================================================
// CONSTANTS
// ============================================================================

/** Excel column letters (A-Z, AA-AZ, etc.) */
export const getColumnLetter = (index: number): string => {
  let letter = '';
  let temp = index;
  while (temp >= 0) {
    letter = String.fromCharCode((temp % 26) + 65) + letter;
    temp = Math.floor(temp / 26) - 1;
  }
  return letter;
};

/** Get column index from letter */
export const getColumnIndex = (letter: string): number => {
  let index = 0;
  for (let i = 0; i < letter.length; i++) {
    index = index * 26 + (letter.charCodeAt(i) - 64);
  }
  return index - 1;
};

/** Field configurations */
export const FIELD_CONFIGS: FieldConfig[] = [
  { field: 'height', label: 'Высота (мм)', required: true, type: 'number' },
  { field: 'width', label: 'Ширина (мм)', required: true, type: 'number' },
  { field: 'quantity', label: 'Количество', required: true, type: 'number' },
  { field: 'edge_type', label: 'Обкатка', required: false, type: 'reference', referenceResource: 'edge_types' },
  { field: 'film', label: 'Плёнка', required: false, type: 'reference', referenceResource: 'films' },
  { field: 'material', label: 'Материал', required: false, type: 'reference', referenceResource: 'materials' },
  { field: 'milling_type', label: 'Фрезеровка', required: false, type: 'reference', referenceResource: 'milling_types' },
  { field: 'note', label: 'Примечание', required: false, type: 'text' },
  { field: 'detail_name', label: 'Название детали', required: false, type: 'text' },
];

/** Keywords for auto-detection of columns */
export const FIELD_KEYWORDS: Record<ImportableField, string[]> = {
  height: ['высота', 'height', 'h', 'выс', 'длина', 'длин'],
  width: ['ширина', 'width', 'w', 'шир'],
  quantity: ['количество', 'quantity', 'qty', 'кол', 'шт', 'кол-во'],
  edge_type: ['обкатка', 'обкат', 'кромка', 'edge', 'обработка'],
  film: ['плёнка', 'пленка', 'film', 'плен'],
  material: ['материал', 'material', 'мат'],
  milling_type: ['фрезеровка', 'фрез', 'milling', 'тип фрез'],
  note: ['примечание', 'note', 'прим', 'коммент'],
  detail_name: ['название', 'name', 'наим', 'деталь'],
};

/** Default values for new details */
export const IMPORT_DEFAULTS = {
  material_id: 1,      // МДФ 16мм
  milling_type_id: 1,  // Модерн
  edge_type_id: 1,     // р-1
  priority: 100,
};
