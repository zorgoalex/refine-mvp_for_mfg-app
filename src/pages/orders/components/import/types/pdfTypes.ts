// Types for PDF Import functionality

// ============================================================================
// PDF TEXT EXTRACTION TYPES
// ============================================================================

export interface PdfTextItem {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontName?: string;
}

export interface PdfTextLine {
  y: number;
  items: PdfTextItem[];
  text: string; // concatenated text
}

export interface PdfPage {
  pageNumber: number;
  lines: PdfTextLine[];
}

// ============================================================================
// PDF DOCUMENT METADATA
// ============================================================================

export interface PdfOrderMetadata {
  orderNumber: string;       // e.g., "1057" - this is doweling number
  orderName: string;         // e.g., "Кухня"
  material: string;          // e.g., "МДФ 16 мм"
  company?: string;          // e.g., "Zhihaz Best"
  printDate?: string;        // e.g., "18.12.2025"
  totalCount?: number;       // e.g., 44 from "Общ. кол. 44"
}

// ============================================================================
// PARSED DETAIL TYPES
// ============================================================================

export interface PdfDetailRaw {
  designation: string;       // "Обозн." - e.g., "11.02", "36", "01.04"
  name: string;              // "Наименование" - e.g., "Бок L", "Фасад Лапша"
  position: number;          // position number in PDF (1, 2, 3...)
  quantity: number;          // "Кол-во"
  length: number;            // first size value (height/length in mm)
  width: number;             // second size value (width in mm)
  milling?: string;          // "Фрезировка" - e.g., "Модерн", "Средняя лапша"
  film?: string;             // "Пленка" - full value, e.g., "AL 17 Айвори софт Алер"
  note?: string;             // "Примечание" - e.g., "Присадка:"
}

export interface PdfParsedResult {
  metadata: PdfOrderMetadata;
  details: PdfDetailRaw[];
  pages: number;
  parseErrors: string[];
}

// ============================================================================
// IMPORT ROW (for validation step - compatible with Excel import)
// ============================================================================

export interface PdfImportRow {
  sourceRowIndex: number;
  height: number;
  width: number;
  quantity: number;
  millingTypeName?: string | null;
  filmName?: string | null;
  note?: string | null;
  detailName: string;        // "designation~~name" format
}

// ============================================================================
// PARSER STATE
// ============================================================================

export interface PdfParserState {
  isLoading: boolean;
  error: string | null;
  result: PdfParsedResult | null;
}

// ============================================================================
// CONSTANTS
// ============================================================================

// Y-coordinate tolerance for grouping text items into lines
export const LINE_Y_TOLERANCE = 5;

// Patterns for detecting header/footer lines to skip
export const HEADER_FOOTER_PATTERNS = [
  /^Заказ:/,
  /^Компания:/,
  /^Разработал:/,
  /^Конструктор:/,
  /^Дата печати:/,
  /^Спецификация/,
  /^Обозн\./,
  /^Наименование/,
  /^Кол-во/,
  /^Размер/,
  /^Фрезировка/,
  /^Материал:/,
  /^Пленка/,
  /^Примечание/,
  /^Изделие:/,
  /^Стр\.\s*\d+/,
];

// Pattern for detecting designation (start of detail block)
// Matches: "11.02", "01.04", "36", "37" but NOT single digits like "1", "2"
// Designation is either: XX.XX format OR two+ digit number
export const DESIGNATION_PATTERN = /^(\d+\.\d+|\d{2,})$/;

// Pattern for extracting order number and name from header
export const ORDER_HEADER_PATTERN = /№\s*(\d+)\s*[\/\\]\s*(.+)/;

// Pattern for extracting material info
export const MATERIAL_PATTERN = /Материал:\s*(.+)/;

// Pattern for extracting total count
export const TOTAL_COUNT_PATTERN = /Общ\.\s*кол\.\s*(\d+)/;
