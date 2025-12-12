// Types for Excel Import functionality

import type { WorkBook } from 'xlsx';

// ============================================================================
// EXCEL DATA TYPES
// ============================================================================

export type CellValue = string | number | boolean | Date | null | undefined;
export type ExcelRow = Record<string, CellValue>;

export interface ParsedSheet {
  name: string;
  data: CellValue[][];
  headers: string[];
  rowCount: number;
  colCount: number;
}

// ============================================================================
// SELECTION TYPES
// ============================================================================

export interface CellPosition {
  row: number;
  col: number;
}

export interface SelectionRange {
  id: string;
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
  color?: string;
}

export interface NormalizedRange {
  minRow: number;
  maxRow: number;
  minCol: number;
  maxCol: number;
}

// ============================================================================
// COLUMN MAPPING TYPES
// ============================================================================

export type ImportableField =
  | 'height'
  | 'width'
  | 'quantity'
  | 'edge_type'
  | 'film'
  | 'material'
  | 'milling_type'
  | 'note'
  | 'detail_name';

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

export interface FieldConfig {
  field: ImportableField;
  label: string;
  required: boolean;
  type: 'number' | 'text' | 'reference';
  referenceResource?: string;
}

// ============================================================================
// IMPORT ROW TYPES
// ============================================================================

export interface ImportRow {
  sourceRowIndex: number;
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

export interface ResolvedRow extends ImportRow {
  edge_type_id?: number | null;
  film_id?: number | null;
  material_id?: number | null;
  milling_type_id?: number | null;
}

export interface FieldError {
  field: string;
  message: string;
  type: 'error' | 'warning';
}

export interface ValidatedRow extends ResolvedRow {
  isValid: boolean;
  errors: FieldError[];
  warnings: FieldError[];
}

// ============================================================================
// IMPORT STATE TYPES
// ============================================================================

export type ImportStep = 'upload' | 'select' | 'validation' | 'complete';
export type ImportMode = 'new_order' | 'existing_order';

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

export const getColumnLetter = (index: number): string => {
  let letter = '';
  let temp = index;
  while (temp >= 0) {
    letter = String.fromCharCode((temp % 26) + 65) + letter;
    temp = Math.floor(temp / 26) - 1;
  }
  return letter;
};

export const getColumnIndex = (letter: string): number => {
  let index = 0;
  for (let i = 0; i < letter.length; i++) {
    index = index * 26 + (letter.charCodeAt(i) - 64);
  }
  return index - 1;
};

export const FIELD_CONFIGS: FieldConfig[] = [
  { field: 'height', label: 'Высота (мм)', required: true, type: 'number' },
  { field: 'width', label: 'Ширина (мм)', required: true, type: 'number' },
  { field: 'quantity', label: 'Количество', required: true, type: 'number' },
  { field: 'edge_type', label: 'Обкат', required: false, type: 'reference', referenceResource: 'edge_types' },
  { field: 'material', label: 'Материал', required: false, type: 'reference', referenceResource: 'materials' },
  { field: 'milling_type', label: 'Фрезеровка', required: false, type: 'reference', referenceResource: 'milling_types' },
  { field: 'film', label: 'Плёнка', required: false, type: 'reference', referenceResource: 'films' },
  { field: 'note', label: 'Примечание', required: false, type: 'text' },
  { field: 'detail_name', label: 'Название детали', required: false, type: 'text' },
];

export const FIELD_KEYWORDS: Record<ImportableField, string[]> = {
  height: ['высота', 'height', 'h', 'выс', 'длина', 'длин'],
  width: ['ширина', 'width', 'w', 'шир'],
  quantity: ['количество', 'quantity', 'qty', 'кол', 'шт', 'кол-во'],
  edge_type: ['обкатка', 'обкат', 'кромка', 'edge', 'обработка'],
  film: ['плёнка', 'пленка', 'film', 'плен'],
  material: ['материал', 'material', 'мат'],
  milling_type: ['фрезеровка', 'фрез', 'milling', 'тип фрез'],
  note: ['примечание', 'note', 'прим', 'коммент', 'комментарий'],
  detail_name: ['название', 'name', 'наим', 'деталь'],
};

export const IMPORT_DEFAULTS = {
  material_id: 1,
  milling_type_id: 1,
  edge_type_id: 1,
  priority: 100,
};
